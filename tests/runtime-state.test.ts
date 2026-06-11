import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statusFromRuntime } from '../src/worker/minecraft/runtime-state.ts';
import type { MinecraftRuntimeStatus } from '../src/worker/types.ts';

const readyRuntime: MinecraftRuntimeStatus = {
  process: 'running',
  containerRunning: true,
  playersOnline: 0,
  activeBridgeConnections: 0,
  maxPlayers: 20,
  players: [],
  rconHealthy: true
};

describe('runtime summary state policy', () => {
  it('does not resurrect a stopped server from a stale ready runtime cache', () => {
    assert.equal(statusFromRuntime('stopped', readyRuntime), 'stopped');
  });

  it('preserves lifecycle errors until an explicit lifecycle operation changes them', () => {
    assert.equal(statusFromRuntime('error', readyRuntime), 'error');
  });

  it('allows startup to become running when the runtime is ready', () => {
    assert.equal(statusFromRuntime('starting', readyRuntime), 'running');
  });

  it('keeps stopping visible until the process has stopped', () => {
    assert.equal(statusFromRuntime('stopping', readyRuntime), 'stopping');
    assert.equal(
      statusFromRuntime('stopping', { ...readyRuntime, process: 'missing', rconHealthy: false }),
      'stopped'
    );
  });
});
