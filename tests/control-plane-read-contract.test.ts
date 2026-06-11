import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function routeBody(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(start, -1, startNeedle);
  assert.notEqual(end, -1, endNeedle);
  return source.slice(start, end);
}

describe('control-plane read contract', () => {
  const worker = readFileSync('src/worker/index.ts', 'utf8');

  it('serves dashboard detail and status from passive UserDO snapshots', () => {
    for (const [start, end] of [
      ["app.get('/api/servers/:serverId'", "app.patch('/api/servers/:serverId'"],
      ["app.get('/api/servers/:serverId/status'", "app.post('/api/servers/:serverId/connect-invite'"]
    ] as const) {
      const route = routeBody(worker, start, end);
      assert.match(route, /authorizedServerSnapshot/);
      assert.doesNotMatch(route, /authorizedServer\(|authorizedManifest\(|minecraftSandboxById|getSandbox|readyMinecraftSandbox|recordRequestLocation/);
    }
  });

  it('serves connector progress and diagnostics from passive UserDO snapshots', () => {
    for (const [start, end] of [
      ['async function handleConnectorProgress', 'async function handleConnectorDiagnostics'],
      ['async function handleConnectorDiagnostics', 'async function authorizeConnectorRequest']
    ] as const) {
      const handler = routeBody(worker, start, end);
      assert.match(handler, /authorizeConnectorSnapshot/);
      assert.doesNotMatch(handler, /authorizeConnectorRequest|authorizedServer\(|minecraftSandboxById|getSandbox|runtimeSnapshot|readyMinecraftSandbox|processLogSnapshot|getProcessLogs/);
    }
  });

  it('keeps wakeful sandbox access explicit for actions and live tools', () => {
    const wakefulRoutes = [
      ["app.post('/api/servers/:serverId/start'", "app.post('/api/servers/:serverId/stop'"],
      ["app.get('/api/servers/:serverId/logs/stream'", "app.get('/api/servers/:serverId/terminal'"],
      ["app.get('/api/servers/:serverId/terminal'", "app.post('/api/servers/:serverId/rcon'"],
      ["app.get('/api/servers/:serverId/files'", "app.get('/api/servers/:serverId/files/changes'"]
    ] as const;

    for (const [start, end] of wakefulRoutes) {
      const route = routeBody(worker, start, end);
      assert.match(route, /authorizedServer\(|authorizedManifest\(|readyMinecraftSandbox\(/);
      assert.doesNotMatch(route, /authorizedServerSnapshot/);
    }
  });

  it('backfills snapshots once for servers that predate snapshot sync', () => {
    for (const [start, end] of [
      ['async function authorizedServerSnapshot', 'async function authorizedManifest'],
      ['async function authorizeConnectorSnapshot', 'function connectorServerMatches']
    ] as const) {
      const helper = routeBody(worker, start, end);
      assert.match(helper, /publishControlSnapshot\(\)/);
    }
  });
});
