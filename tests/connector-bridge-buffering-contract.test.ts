import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('connector websocket bridge buffering contract', () => {
  it('drains websocket frames left over from the HTTP upgrade response', () => {
    const source = readFileSync('bin/cubeflare.mjs', 'utf8');
    const start = source.indexOf('async function connectWebSocket');
    const end = source.indexOf('function writeClientFrame');
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const body = source.slice(start, end);
    assert.match(body, /const pendingFrames = \[\]/);
    assert.match(body, /set onData\(handler\)/);
    assert.match(body, /processServerFrames\(\);\s*\n\s*return bridge/);
  });
});
