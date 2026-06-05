import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('connector latency contract', () => {
  it('does not re-run full server startup when opening an already-started bridge endpoint', () => {
    const source = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');
    const start = source.indexOf('async getBridgeEndpoint');
    const end = source.indexOf('async getDynmapPreview');
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body = source.slice(start, end);
    assert.doesNotMatch(body, /startServer\(/);
    assert.doesNotMatch(body, /startBridge\(/);
    assert.match(body, /exposePort\(BRIDGE_PORT/);
  });

  it('uses cached ready runtime before touching process and RCON checks on warm start', () => {
    const source = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');
    const start = source.indexOf('async startServer');
    const end = source.indexOf('async stopServer');
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body = source.slice(start, end);
    assert.match(body, /await this\.readyCachedRuntime\(manifest\)/);
    assert.match(body, /previous === ["']running["'] && cached/);
    assert.ok(body.indexOf('readyCachedRuntime(manifest)') < body.indexOf('bootMinecraft('));
  });

  it('validates cached ready runtime with a bounded Minecraft TCP probe', () => {
    const source = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');
    const start = source.indexOf('private async readyCachedRuntime');
    const end = source.indexOf('private isRuntimeReady');
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body = source.slice(start, end);
    assert.match(body, /isRuntimeReady\(runtime\)/);
    assert.match(body, /isTcpPortAccepting\(MINECRAFT_PORT, 1500\)/);
  });

  it('does not wait for Minecraft ports again after runtime is already ready', () => {
    const source = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');
    const start = source.indexOf('private async bootMinecraft');
    const end = source.indexOf('private async bootMinecraftInner');
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body = source.slice(start, end);
    assert.match(body, /!this\.isRuntimeReady\(runtime\)/);
    assert.match(body, /return runtime/);
  });
});
