import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('connector progress contract', () => {
  it('exposes passive connector progress without reading process logs', () => {
    const source = readFileSync('src/worker/index.ts', 'utf8');
    const handlerStart = source.indexOf('async function handleConnectorProgress');
    const handlerEnd = source.indexOf('async function handleConnectorDiagnostics');
    assert.notEqual(handlerStart, -1);
    assert.notEqual(handlerEnd, -1);

    const handler = source.slice(handlerStart, handlerEnd);
    assert.match(source, /app\.post\('\/api\/connect\/progress'/);
    assert.match(handler, /getLifecyclePhase\(\)/);
    assert.doesNotMatch(handler, /processLogSnapshot|getProcessLogs|readyMinecraftSandbox|startServer/);
  });

  it('polls connector progress while preparing the bridge session', () => {
    const source = readFileSync('public/downloads/cubeflare', 'utf8');
    const start = source.indexOf('async function prepareBridgeSession');
    const end = source.indexOf('function createActivityReporter');
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body = source.slice(start, end);
    assert.match(body, /fetchConnectorProgress/);
    assert.match(source, /\/api\/connect\/progress/);
  });
});
