import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('Dynmap diagnostics contract', () => {
  it('includes the dynmap sync helper in authenticated server diagnostics', () => {
    const source = readFileSync('src/worker/index.ts', 'utf8');
    const snapshotStart = source.indexOf('async function processLogSnapshot');
    const snapshotEnd = source.indexOf('function tailLines');
    assert.notEqual(snapshotStart, -1);
    assert.notEqual(snapshotEnd, -1);

    const snapshot = source.slice(snapshotStart, snapshotEnd);
    assert.match(snapshot, /minecraft-server/);
    assert.match(snapshot, /minecraft-bridge/);
    assert.match(snapshot, /dynmap-sync/);
    assert.match(snapshot, /processes/);
  });

  it('reads Dynmap runtime status through the local bridge instead of Sandbox file APIs', () => {
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');
    const methodStart = sandbox.indexOf('async getDynmapRuntimeStatus');
    const methodEnd = sandbox.indexOf('async getRuntimeStatus');
    assert.notEqual(methodStart, -1);
    assert.notEqual(methodEnd, -1);

    const method = sandbox.slice(methodStart, methodEnd);
    assert.match(method, /containerFetch/);
    assert.match(method, /dynmap-status/);
    assert.match(method, /withTimeout/);
    assert.match(method, /Dynmap bridge status/);
    assert.doesNotMatch(method, /listFiles|readFile|getProcessLogs/);
  });

  it('bounds diagnostics-only sandbox calls so observability cannot hang the API', () => {
    const source = readFileSync('src/worker/index.ts', 'utf8');
    const routeStart = source.indexOf("app.get('/api/servers/:serverId/diagnostics'");
    const routeEnd = source.indexOf("app.post('/api/servers/:serverId/backups'");
    assert.notEqual(routeStart, -1);
    assert.notEqual(routeEnd, -1);

    const route = source.slice(routeStart, routeEnd);
    assert.match(route, /withTimeout\(\s*processLogSnapshot/);
    assert.match(route, /Process snapshot/);
    assert.match(route, /withTimeout\(\s*server\.getDynmapRuntimeStatus/);
    assert.match(route, /Dynmap runtime status/);
  });

  it('serves Dynmap status from the bridge process with an internal secret', () => {
    const bridge = readFileSync('container/bin/cubeflare-ws-bridge.mjs', 'utf8');

    assert.match(bridge, /\/dynmap-status/);
    assert.match(bridge, /x-cubeflare-dynmap-secret/);
    assert.match(bridge, /CUBEFLARE_DYNMAP_SYNC_SECRET/);
    assert.match(bridge, /CUBEFLARE_BRIDGE_SECRET/);
    assert.match(bridge, /dynmap-sync-status\.json/);
  });

  it('runs the bridge and Dynmap sync under the Minecraft supervisor process', () => {
    const runner = readFileSync('container/bin/cubeflare-run-server.sh', 'utf8');
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.match(runner, /cubeflare-ws-bridge\.mjs &/);
    assert.match(runner, /cubeflare-dynmap-sync\.mjs &/);
    assert.match(runner, /trap cleanup EXIT INT TERM/);
    assert.match(sandbox, /waiting_bridge/);
    assert.doesNotMatch(sandbox, /startBridge\(manifest\)/);
    assert.doesNotMatch(sandbox, /startDynmapSync\(manifest\)/);
  });

  it('serves mirrored Dynmap with generated endpoint routing and iframe-safe headers', () => {
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const http = readFileSync('src/worker/http.ts', 'utf8');

    assert.match(worker, /c\.req\.path\.startsWith\('\/map\/'\)/);
    assert.match(worker, /app\.get\('\/map\/:serverId'/);
    assert.match(worker, /function dynmapPathSuffix/);
    assert.equal(worker.includes('const worldUpdate = /^up\\/world\\/([^/]+)\\/[^/]+$/.exec(suffix);'), true);
    assert.match(worker, /latest\.json/);
    assert.match(worker, /function dynmapStandaloneConfigResponse/);
    assert.match(worker, /dynmapSecurityHeaders/);
    assert.match(http, /export function dynmapSecurityHeaders/);
    assert.match(http, /headers\.delete\('X-Frame-Options'\)/);
    assert.match(http, /frame-ancestors 'self'/);
  });

  it('does not mark the mirrored map available until world tiles exist', () => {
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const routeStart = worker.indexOf("app.get('/api/servers/:serverId/dynmap'");
    const routeEnd = worker.indexOf("app.post('/api/servers/:serverId/dynmap/render'");
    assert.notEqual(routeStart, -1);
    assert.notEqual(routeEnd, -1);
    const route = worker.slice(routeStart, routeEnd);

    assert.match(route, /hasDynmapWorldTiles/);
    assert.match(route, /tilesAvailable/);
    assert.match(route, /available: enabled && Boolean\(mirroredIndex\) && tilesAvailable/);
    assert.match(worker, /prefix: `dynmap\/\$\{serverId\}\/tiles\/\$\{world\}\/`/);
    assert.match(worker, /cleanDynmapWorldName/);
  });

  it('exposes an authenticated owner action for starting a Dynmap render', () => {
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.match(worker, /app\.post\('\/api\/servers\/:serverId\/dynmap\/render', requireAuth\(\)/);
    assert.match(worker, /authorizedServer/);
    assert.match(worker, /startDynmapRender\('user-dynmap-render'\)/);
    assert.match(worker, /app\.post\('\/api\/cli\/servers\/dynmap\/render'/);
    assert.match(worker, /authenticateCliRequest/);
    assert.match(worker, /startDynmapRenderForCli/);
    assert.match(sandbox, /async startDynmapRender/);
    assert.match(sandbox, /dynmap radiusrender world 0 0/);
    assert.doesNotMatch(sandbox, /dynmap fullrender world/);
  });

  it('points the mirror sync helper at the container-local Dynmap server', () => {
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.match(sandbox, /CUBEFLARE_DYNMAP_LOCAL_BASE_URL/);
    assert.match(sandbox, /http:\/\/127\.0\.0\.1:8123/);
  });
});
