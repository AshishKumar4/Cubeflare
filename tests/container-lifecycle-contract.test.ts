import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('container lifecycle contract', () => {
  it('leaves the Durable Object alarm handler to the Container base class', () => {
    const source = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.equal(/\basync\s+alarm\s*\(/.test(source), false);
    assert.equal(/ctx\.storage\.(setAlarm|deleteAlarm|getAlarm)\s*\(/.test(source), false);
  });
});
