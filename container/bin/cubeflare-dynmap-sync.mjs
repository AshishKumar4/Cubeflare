#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const serverId = process.env.CUBEFLARE_SERVER_ID;
const secret = process.env.CUBEFLARE_DYNMAP_SYNC_SECRET;
const baseUrl = process.env.CUBEFLARE_INTERNAL_BASE_URL;
const root = process.env.CUBEFLARE_DYNMAP_ROOT || '/workspace/server/plugins/dynmap/web';
const statusPath = process.env.CUBEFLARE_DYNMAP_SYNC_STATUS_PATH || '/workspace/server/.cubeflare/dynmap-sync-status.json';
const dynmapLocalBaseUrl = (process.env.CUBEFLARE_DYNMAP_LOCAL_BASE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const seen = new Map();
const idleScanIntervalMs = Number.parseInt(process.env.CUBEFLARE_DYNMAP_IDLE_SCAN_INTERVAL_MS || '5000', 10);
const steadyScanIntervalMs = Number.parseInt(process.env.CUBEFLARE_DYNMAP_SCAN_INTERVAL_MS || '30000', 10);
const uploadTimeoutMs = Number.parseInt(process.env.CUBEFLARE_DYNMAP_UPLOAD_TIMEOUT_MS || '15000', 10);
const dynamicFetchTimeoutMs = Number.parseInt(process.env.CUBEFLARE_DYNMAP_DYNAMIC_TIMEOUT_MS || '5000', 10);

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!serverId || !secret || !baseUrl) {
    console.log('Dynmap sync disabled: missing server id, sync secret, or internal base URL');
    await writeStatus({
      ok: false,
      state: 'disabled',
      root,
      error: 'missing server id, sync secret, or internal base URL'
    });
    process.exit(0);
  }

  await runLoop();
}

async function runLoop() {
  await writeStatus({ ok: true, state: 'running', root });
  for (;;) {
    let delayMs = nextScanDelayMs({ scannedFiles: 0 });
    try {
      const result = await syncOnce();
      delayMs = nextScanDelayMs(result);
      await writeStatus({
        ok: true,
        state: 'synced',
        root,
        scannedFiles: result.scannedFiles,
        uploadedFiles: result.uploadedFiles,
        lastScanAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('dynmap sync failed', error);
      await writeStatus({
        ok: false,
        state: 'error',
        root,
        error: error instanceof Error ? error.message : String(error),
        lastScanAt: new Date().toISOString()
      });
    }
    await sleep(delayMs);
  }
}

export async function syncOnce() {
  let scannedFiles = 0;
  let uploadedFiles = 0;
  for await (const file of walk(root)) {
    const info = await stat(file);
    if (!info.isFile()) continue;
    scannedFiles++;
    const rel = relative(root, file).replaceAll('\\', '/');
    const marker = `${info.mtimeMs}:${info.size}`;
    const body = await readFile(file);
    if (await uploadChanged(rel, body, marker, contentType(rel))) uploadedFiles++;
  }
  const dynamic = await syncDynamicEndpoints();
  return {
    scannedFiles: scannedFiles + dynamic.scannedFiles,
    uploadedFiles: uploadedFiles + dynamic.uploadedFiles
  };
}

async function syncDynamicEndpoints() {
  let scannedFiles = 0;
  let uploadedFiles = 0;

  const standaloneConfig = await fetchDynmap('standalone/config.js');
  if (!standaloneConfig) return { scannedFiles, uploadedFiles };
  scannedFiles++;
  if (
    await uploadChanged(
      'standalone/config.js',
      standaloneConfig.body,
      bodyMarker(standaloneConfig.body),
      'text/javascript; charset=utf-8'
    )
  ) {
    uploadedFiles++;
  }

  const configuration = await fetchDynmap('up/configuration');
  if (!configuration) return { scannedFiles, uploadedFiles };
  scannedFiles++;
  if (
    await uploadChanged(
      'up/configuration',
      configuration.body,
      bodyMarker(configuration.body),
      'application/json; charset=utf-8'
    )
  ) {
    uploadedFiles++;
  }

  let parsedConfiguration;
  try {
    parsedConfiguration = JSON.parse(configuration.body.toString('utf8'));
  } catch {
    return { scannedFiles, uploadedFiles };
  }

  const worlds = Array.isArray(parsedConfiguration.worlds) ? parsedConfiguration.worlds : [];
  for (const world of worlds) {
    const name = cleanWorldName(world?.name);
    if (!name) continue;
    const update = await fetchDynmap(`up/world/${name}/0`);
    if (!update) continue;
    scannedFiles++;
    if (
      await uploadChanged(
        `up/world/${name}/latest.json`,
        update.body,
        bodyMarker(update.body),
        'application/json; charset=utf-8'
      )
    ) {
      uploadedFiles++;
    }
  }

  return { scannedFiles, uploadedFiles };
}

async function fetchDynmap(rel) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dynamicFetchTimeoutMs);
  try {
    const response = await fetch(`${dynmapLocalBaseUrl}/${encodeDynmapPath(rel)}`, {
      signal: controller.signal
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { body: Buffer.from(bytes) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadChanged(rel, body, marker, type) {
  if (seen.get(rel) === marker) return false;
  await upload(rel, body, type);
  seen.set(rel, marker);
  return true;
}

async function upload(rel, body, type) {
  await writeStatus({
    ok: true,
    state: 'uploading',
    root,
    file: rel
  });
  const timestamp = Date.now();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${serverId}.${rel}.${timestamp}`)
    .digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/internal/dynmap/${serverId}/${encodeDynmapPath(rel)}`, {
      method: 'PUT',
      headers: {
        'x-cubeflare-timestamp': String(timestamp),
        'x-cubeflare-signature': signature,
        'content-type': type,
        'content-length': String(body.byteLength)
      },
      body,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`upload ${rel} timed out after ${uploadTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`upload ${rel} failed: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }
}

export function encodeDynmapPath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

function bodyMarker(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function cleanWorldName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.includes('/') || name.includes('\\') || name.split('/').includes('..')) return null;
  return name;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function contentType(path) {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

async function writeStatus(status) {
  try {
    await mkdir(dirname(statusPath), { recursive: true });
    await writeFile(statusPath, `${JSON.stringify({
      ...status,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`);
  } catch (error) {
    console.error('dynmap sync status write failed', error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextScanDelayMs(result) {
  const requested = result.scannedFiles === 0 ? idleScanIntervalMs : steadyScanIntervalMs;
  return Number.isFinite(requested) && requested > 0 ? requested : 30_000;
}
