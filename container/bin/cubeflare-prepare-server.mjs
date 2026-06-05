#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { download, exists, resolveServerJarUrl } from './cubeflare-server-resolver.mjs';

const manifestPath = process.argv[2] || process.env.CUBEFLARE_MANIFEST_PATH;
if (!manifestPath) {
  throw new Error('Manifest path is required');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const serverDir = '/workspace/server';
const pluginDir = join(serverDir, 'plugins');

await mkdir(join(serverDir, '.cubeflare'), { recursive: true });
await mkdir(pluginDir, { recursive: true });
await writeFile(join(serverDir, 'eula.txt'), 'eula=true\n');

await prepareJar(manifest);
await writeServerProperties(manifest);
await writeJavaArgs(manifest);
await writePlayerLists(manifest);
await preparePlugins(manifest);
await runSetupScript(manifest);

async function prepareJar(m) {
  const jarPath = join(serverDir, 'server.jar');
  if (await exists(jarPath)) return;

  if (m.preset === 'custom') {
    if (!m.setupScript) {
      throw new Error('Custom preset requires setupScript to create /workspace/server/server.jar');
    }
    return;
  }

  const url = await resolveServerJarUrl(m.preset, m.version);
  await download(url, jarPath);
}

async function writeServerProperties(m) {
  const props = {
    'server-port': 25565,
    'enable-rcon': true,
    'rcon.port': 25575,
    'rcon.password': m.rconPassword,
    'online-mode': m.onlineMode,
    'motd': m.motd,
    'max-players': m.maxPlayers,
    'level-seed': m.seed ?? '',
    'difficulty': m.difficulty,
    'gamemode': m.gameMode,
    'enable-command-block': m.enableCommandBlock,
    'allow-nether': m.allowNether,
    'view-distance': m.viewDistance,
    'simulation-distance': m.simulationDistance,
    'pvp': m.pvp,
    'white-list': m.whitelist,
    ...m.serverProperties
  };
  const lines = Object.entries(props)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
  await writeFile(join(serverDir, 'server.properties'), `${lines}\n`);
}

async function writeJavaArgs(m) {
  const profile = m.java?.flagsProfile || defaultFlagsProfile(m.preset);
  const args = [...javaArgsForProfile(profile), ...cleanExtraJavaFlags(m.java?.extraFlags)];
  await writeFile(join(serverDir, '.cubeflare', 'java.args'), `${args.join('\n')}\n`);
}

function defaultFlagsProfile(preset) {
  return preset === 'paper' || preset === 'purpur' || preset === 'folia'
    ? 'aikar-g1'
    : 'modern-g1';
}

function javaArgsForProfile(profile) {
  if (profile === 'aikar-g1') {
    return [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1',
      '-Dusing.aikars.flags=https://mcflags.emc.gs',
      '-Daikars.new.flags=true'
    ];
  }

  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    '-XX:+PerfDisableSharedMem'
  ];
}

function cleanExtraJavaFlags(flags) {
  if (!Array.isArray(flags)) return [];
  return flags
    .filter((flag) => typeof flag === 'string')
    .map((flag) => flag.trim())
    .filter((flag) => flag && !/[\r\n\0]/.test(flag))
    .slice(0, 80);
}

async function writePlayerLists(m) {
  await writeFile(
    join(serverDir, 'ops.json'),
    JSON.stringify(m.ops.map((name) => ({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: false })), null, 2)
  );
  await writeFile(
    join(serverDir, 'whitelist.json'),
    JSON.stringify(m.whitelistPlayers.map((name) => ({ uuid: offlineUuid(name), name })), null, 2)
  );
}

async function preparePlugins(m) {
  await removeStaleDynmapPlugin(m);
  for (const plugin of m.plugins ?? []) {
    const target = join(pluginDir, plugin.filename);
    const disabled = `${target}.disabled`;
    if (!plugin.enabled) {
      if (await exists(target)) await rename(target, disabled).catch(() => undefined);
      continue;
    }
    if ((await exists(disabled)) && !(await exists(target))) {
      await rename(disabled, target).catch(() => undefined);
    }

    if (plugin.source.type === 'builtin') {
      const source = await builtinPluginSource(plugin.source.id);
      const marker = join(serverDir, '.cubeflare', `${plugin.source.id}.plugin-source.txt`);
      if (await exists(target)) {
        const previousSource = await readFile(marker, 'utf8').catch(() => '');
        if (source && previousSource.trim() === source.marker) continue;
      }
      if (!source) {
        throw new Error(`Built-in plugin ${plugin.source.id} is not available in this container image`);
      }
      if (source.type === 'url') {
        await download(source.value, target);
      } else {
        await copyFile(source.value, target);
      }
      await writeFile(marker, `${source.marker}\n`);
      continue;
    }

    if (await exists(target)) continue;

    if (plugin.source.type === 'url') {
      await download(plugin.source.url, target);
    }
  }
}

async function removeStaleDynmapPlugin(m) {
  const configuredDynmap = (m.plugins ?? []).some((plugin) => plugin.enabled && plugin.filename === 'dynmap.jar');
  if (configuredDynmap) return;
  await unlink(join(pluginDir, 'dynmap.jar')).catch(() => undefined);
  await unlink(join(pluginDir, 'dynmap.jar.disabled')).catch(() => undefined);
  await unlink(join(serverDir, '.cubeflare', 'dynmap.plugin-url.txt')).catch(() => undefined);
  await unlink(join(serverDir, '.cubeflare', 'dynmap.plugin-source.txt')).catch(() => undefined);
}

async function runSetupScript(m) {
  if (!m.setupScript) return;
  const scriptPath = join(serverDir, '.cubeflare', 'setup.sh');
  await writeFile(scriptPath, `${m.setupScript}\n`);
  await chmod(scriptPath, 0o700);
  await run('bash', [scriptPath], serverDir);
}

async function builtinPluginSource(id) {
  if (id === 'dynmap') {
    if (process.env.CUBEFLARE_DYNMAP_PLUGIN_URL) {
      return {
        type: 'url',
        value: process.env.CUBEFLARE_DYNMAP_PLUGIN_URL,
        marker: `url:${process.env.CUBEFLARE_DYNMAP_PLUGIN_URL}`
      };
    }
    const localPath = '/opt/cubeflare/plugins/dynmap.jar';
    if (await exists(localPath)) {
      return {
        type: 'file',
        value: localPath,
        marker: 'file:/opt/cubeflare/plugins/dynmap.jar#sha256=72524da60e29209c28c5469c58149b1cdbda4b51a2c315e595220e658d8070af'
      };
    }
  }
  return null;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

function offlineUuid(name) {
  let hash = 0;
  for (const char of `OfflinePlayer:${name}`) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
