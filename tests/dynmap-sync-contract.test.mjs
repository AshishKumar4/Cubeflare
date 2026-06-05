import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

const syncModuleUrl = pathToFileURL(join(process.cwd(), 'container/bin/cubeflare-dynmap-sync.mjs')).href;

describe('Dynmap sync contract', () => {
  it('encodes path segments without collapsing nested tile paths', async () => {
    const { encodeDynmapPath } = await import(`${syncModuleUrl}?encode=${Date.now()}`);

    assert.equal(
      encodeDynmapPath('tiles/world surface/0/0/-1_2.png'),
      'tiles/world%20surface/0/0/-1_2.png'
    );
  });

  it('uploads changed web files to the Worker mirror endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cubeflare-dynmap-'));
    const secret = 'test-secret';
    const serverId = 'server-one';
    const rel = 'tiles/world surface/index.html';
    const body = 'dynmap html';
    const requests = [];
    const httpServer = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });

    await writeFile(join(root, 'tiles-world-placeholder'), '');
    await rm(join(root, 'tiles-world-placeholder'));
    await writeFile(join(root, 'index.tmp'), '');
    await rm(join(root, 'index.tmp'));
    await writeFile(join(root, 'robots.txt'), 'skip me');
    await rm(join(root, 'robots.txt'));
    await mkdirp(join(root, 'tiles/world surface'));
    await writeFile(join(root, rel), body);

    try {
      const baseUrl = await listen(httpServer);
      process.env.CUBEFLARE_SERVER_ID = serverId;
      process.env.CUBEFLARE_DYNMAP_SYNC_SECRET = secret;
      process.env.CUBEFLARE_INTERNAL_BASE_URL = baseUrl;
      process.env.CUBEFLARE_DYNMAP_ROOT = root;
      process.env.CUBEFLARE_DYNMAP_SYNC_STATUS_PATH = join(root, 'status.json');
      process.env.CUBEFLARE_DYNMAP_LOCAL_BASE_URL = 'http://127.0.0.1:9';
      process.env.CUBEFLARE_DYNMAP_UPLOAD_TIMEOUT_MS = '1000';
      process.env.CUBEFLARE_DYNMAP_DYNAMIC_TIMEOUT_MS = '100';

      const { syncOnce } = await import(`${syncModuleUrl}?sync=${Date.now()}`);
      const result = await syncOnce();

      assert.equal(result.scannedFiles, 1);
      assert.equal(result.uploadedFiles, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, `/internal/dynmap/${serverId}/tiles/world%20surface/index.html`);
      assert.equal(requests[0].body, body);
      assert.equal(requests[0].headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(requests[0].headers['content-length'], String(Buffer.byteLength(body)));
      const timestamp = requests[0].headers['x-cubeflare-timestamp'];
      assert.ok(timestamp);
      assert.equal(
        requests[0].headers['x-cubeflare-signature'],
        crypto.createHmac('sha256', secret).update(`${serverId}.${rel}.${timestamp}`).digest('hex')
      );
    } finally {
      httpServer.close();
      await rm(root, { recursive: true, force: true });
      delete process.env.CUBEFLARE_SERVER_ID;
      delete process.env.CUBEFLARE_DYNMAP_SYNC_SECRET;
      delete process.env.CUBEFLARE_INTERNAL_BASE_URL;
      delete process.env.CUBEFLARE_DYNMAP_ROOT;
      delete process.env.CUBEFLARE_DYNMAP_SYNC_STATUS_PATH;
      delete process.env.CUBEFLARE_DYNMAP_LOCAL_BASE_URL;
      delete process.env.CUBEFLARE_DYNMAP_UPLOAD_TIMEOUT_MS;
      delete process.env.CUBEFLARE_DYNMAP_DYNAMIC_TIMEOUT_MS;
    }
  });

  it('mirrors Dynmap generated browser endpoints from the local web server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cubeflare-dynmap-dynamic-root-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'cubeflare-dynmap-dynamic-state-'));
    const secret = 'test-secret';
    const serverId = 'server-dynamic';
    const requests = [];
    const configuration = {
      worlds: [{ name: 'world' }, { name: 'world_nether' }]
    };
    const updates = {
      world: { timestamp: 1, players: [], updates: [] },
      world_nether: { timestamp: 2, players: [], updates: [] }
    };
    const dynmapServer = createServer((req, res) => {
      if (req.url === '/standalone/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end("var config = { url: { configuration: 'up/configuration' } };");
        return;
      }
      if (req.url === '/up/configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(configuration));
        return;
      }
      if (req.url === '/up/world/world/0') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(updates.world));
        return;
      }
      if (req.url === '/up/world/world_nether/0') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(updates.world_nether));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    const uploadServer = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });

    try {
      const dynmapBaseUrl = await listen(dynmapServer);
      const baseUrl = await listen(uploadServer);
      process.env.CUBEFLARE_SERVER_ID = serverId;
      process.env.CUBEFLARE_DYNMAP_SYNC_SECRET = secret;
      process.env.CUBEFLARE_INTERNAL_BASE_URL = baseUrl;
      process.env.CUBEFLARE_DYNMAP_ROOT = root;
      process.env.CUBEFLARE_DYNMAP_SYNC_STATUS_PATH = join(stateDir, 'status.json');
      process.env.CUBEFLARE_DYNMAP_LOCAL_BASE_URL = dynmapBaseUrl;
      process.env.CUBEFLARE_DYNMAP_UPLOAD_TIMEOUT_MS = '1000';
      process.env.CUBEFLARE_DYNMAP_DYNAMIC_TIMEOUT_MS = '1000';

      const { syncOnce } = await import(`${syncModuleUrl}?dynamic=${Date.now()}`);
      const result = await syncOnce();

      assert.equal(result.scannedFiles, 4);
      assert.equal(result.uploadedFiles, 4);
      assert.deepEqual(
        requests.map((request) => request.url).sort(),
        [
          `/internal/dynmap/${serverId}/standalone/config.js`,
          `/internal/dynmap/${serverId}/up/configuration`,
          `/internal/dynmap/${serverId}/up/world/world/latest.json`,
          `/internal/dynmap/${serverId}/up/world/world_nether/latest.json`
        ].sort()
      );
      const update = requests.find((request) => request.url?.endsWith('/up/world/world/latest.json'));
      assert.ok(update);
      assert.equal(update.headers['content-type'], 'application/json; charset=utf-8');
      assert.deepEqual(JSON.parse(update.body), updates.world);
    } finally {
      dynmapServer.close();
      uploadServer.close();
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
      delete process.env.CUBEFLARE_SERVER_ID;
      delete process.env.CUBEFLARE_DYNMAP_SYNC_SECRET;
      delete process.env.CUBEFLARE_INTERNAL_BASE_URL;
      delete process.env.CUBEFLARE_DYNMAP_ROOT;
      delete process.env.CUBEFLARE_DYNMAP_SYNC_STATUS_PATH;
      delete process.env.CUBEFLARE_DYNMAP_LOCAL_BASE_URL;
      delete process.env.CUBEFLARE_DYNMAP_UPLOAD_TIMEOUT_MS;
      delete process.env.CUBEFLARE_DYNMAP_DYNAMIC_TIMEOUT_MS;
    }
  });

  it('keeps scanning while Dynmap is still creating its web root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cubeflare-dynmap-loop-root-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'cubeflare-dynmap-loop-state-'));
    const statusPath = join(stateDir, 'status.json');
    const child = spawn(process.execPath, [new URL(syncModuleUrl).pathname], {
      stdio: 'ignore',
      env: {
        ...process.env,
        CUBEFLARE_SERVER_ID: 'server-loop',
        CUBEFLARE_DYNMAP_SYNC_SECRET: 'test-secret',
        CUBEFLARE_INTERNAL_BASE_URL: 'http://127.0.0.1:9',
        CUBEFLARE_DYNMAP_ROOT: join(root, 'missing-web-root'),
        CUBEFLARE_DYNMAP_SYNC_STATUS_PATH: statusPath,
        CUBEFLARE_DYNMAP_LOCAL_BASE_URL: 'http://127.0.0.1:9',
        CUBEFLARE_DYNMAP_IDLE_SCAN_INTERVAL_MS: '100',
        CUBEFLARE_DYNMAP_SCAN_INTERVAL_MS: '100',
        CUBEFLARE_DYNMAP_UPLOAD_TIMEOUT_MS: '100',
        CUBEFLARE_DYNMAP_DYNAMIC_TIMEOUT_MS: '100'
      }
    });

    try {
      const first = await readStatusAfter(statusPath, undefined, 'synced');
      const second = await readStatusAfter(statusPath, first.updatedAt, 'synced');
      assert.equal(first.state, 'synced');
      assert.equal(second.state, 'synced');
      assert.equal(second.scannedFiles, 0);
      assert.notEqual(second.updatedAt, first.updatedAt);
      assert.equal(child.exitCode, null);
    } finally {
      child.kill('SIGTERM');
      await onceExit(child);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

async function mkdirp(path) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind test server'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readStatusAfter(path, previousUpdatedAt, state) {
  const deadline = Date.now() + 3000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(await readFile(path, 'utf8'));
      const updated = !previousUpdatedAt || status.updatedAt !== previousUpdatedAt;
      const stateMatches = !state || status.state === state;
      if (updated && stateMatches) return status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError ?? new Error('Timed out waiting for Dynmap sync status update');
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}
