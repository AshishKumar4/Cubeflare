import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export async function resolveServerJarUrl(preset, version) {
  if (preset === 'vanilla') {
    const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const item = manifest.versions.find((entry) => entry.id === version);
    if (!item) throw new Error(`Unknown vanilla version ${version}`);
    const details = await fetchJson(item.url);
    return details.downloads.server.url;
  }

  if (preset === 'paper' || preset === 'folia') {
    return resolvePaperFillJarUrl(preset, version);
  }

  if (preset === 'purpur') {
    return `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
  }

  if (preset === 'fabric') {
    const loaders = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
    const selected = loaders.find((entry) => entry.loader?.stable) ?? loaders[0];
    if (!selected) throw new Error(`No Fabric loader found for ${version}`);
    return `https://meta.fabricmc.net/v2/versions/loader/${version}/${selected.loader.version}/${selected.installer.version}/server/jar`;
  }

  throw new Error(`Unsupported preset ${preset}`);
}

export async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Cubeflare/0.1 (minecraft.ashishkumarsingh.com)'
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(`${destination}.tmp`));
  await rename(`${destination}.tmp`, destination);
}

export async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Cubeflare/0.1 (minecraft.ashishkumarsingh.com)'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json();
}

export async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

async function resolvePaperFillJarUrl(project, version) {
  const build = await fetchJson(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds/latest`);
  const download = build.downloads?.['server:default'];
  if (!download?.url) throw new Error(`No ${project} server jar found for ${version}`);
  return download.url;
}
