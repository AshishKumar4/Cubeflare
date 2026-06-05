import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { builtinDynmapCompatibility } from '../src/shared/minecraft-map.ts';

describe('Dynmap compatibility', () => {
  it('limits the built-in Dynmap plugin to compatible Bukkit/Paper versions', () => {
    assert.equal(builtinDynmapCompatibility('paper', '1.21.11').compatible, true);
    assert.equal(builtinDynmapCompatibility('purpur', '1.21.8').compatible, true);
    assert.equal(builtinDynmapCompatibility('paper', '26.1.2').compatible, true);
    assert.equal(builtinDynmapCompatibility('folia', '1.21.11').compatible, false);
    assert.equal(builtinDynmapCompatibility('vanilla', '1.21.11').compatible, false);
  });

  it('filters incompatible built-in Dynmap from created and patched manifests', () => {
    const presets = readFileSync('src/worker/minecraft/presets.ts', 'utf8');

    assert.match(presets, /isBuiltinDynmapSupported\(preset, version\)/);
    assert.match(presets, /mergePlugins\(input\.request\.plugins, dynmapSupported\)/);
    assert.match(presets, /mergePlugins\(patch\.plugins, dynmapSupported\)/);
    assert.match(presets, /mergePlugins\(manifest\.plugins, dynmapSupported\)/);
    assert.match(presets, /plugin\.source\.id === 'dynmap' && !includeBuiltinDynmap/);
  });

  it('normalizes legacy manifests before runtime launch', () => {
    const presets = readFileSync('src/worker/minecraft/presets.ts', 'utf8');
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.match(presets, /export function normalizeManifestCompatibility/);
    assert.match(presets, /mergePlugins\(manifest\.plugins, dynmapSupported\)/);
    assert.match(sandbox, /normalizeManifestCompatibility\(manifest\)/);
  });

  it('does not re-enable Dynmap when a compatible user disables the plugin', () => {
    const presets = readFileSync('src/worker/minecraft/presets.ts', 'utf8');

    assert.match(presets, /const requestedDynmapEnabled = patch\.dynmap\?\.enabled \?\? manifest\.dynmap\.enabled/);
    assert.match(presets, /const dynmapEnabled = requestedDynmapEnabled && canEnableDynmap/);
    assert.match(presets, /return hasEnabledDynmapPlugin\(plugins\)/);
  });

  it('removes stale Dynmap jars during container preparation when the manifest excludes Dynmap', () => {
    const preparer = readFileSync('container/bin/cubeflare-prepare-server.mjs', 'utf8');

    assert.match(preparer, /removeStaleDynmapPlugin\(m\)/);
    assert.match(preparer, /unlink\(join\(pluginDir, 'dynmap\.jar'\)\)/);
    assert.match(preparer, /unlink\(join\(pluginDir, 'dynmap\.jar\.disabled'\)\)/);
  });

  it('installs built-in Dynmap from the pinned container artifact', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const preparer = readFileSync('container/bin/cubeflare-prepare-server.mjs', 'utf8');
    const artifact = readFileSync('container/plugins/dynmap.jar');
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex');

    assert.match(dockerfile, /COPY container\/plugins\/ \/opt\/cubeflare\/plugins\//);
    assert.match(preparer, /copyFile\(source\.value, target\)/);
    assert.equal(artifactSha256, '72524da60e29209c28c5469c58149b1cdbda4b51a2c315e595220e658d8070af');
    assert.ok(preparer.includes(`file:/opt/cubeflare/plugins/dynmap.jar#sha256=${artifactSha256}`));
    assert.doesNotMatch(preparer, /curseforge\.com\/api\/v1\/mods\/59433/);
  });
});
