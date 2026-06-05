import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planLifecycleAlarm, shouldRenewContainerActivity } from '../src/worker/minecraft/lifecycle-policy.ts';

describe('Minecraft lifecycle alarm policy', () => {
  it('does not wake or back up a sandbox whose container is not running', () => {
    assert.deepEqual(
      planLifecycleAlarm({
        hasManifest: true,
        containerRunning: false,
        status: 'running',
        activeBridgeConnections: 1
      }),
      {
        inspectRuntime: false,
        runBackup: false
      }
    );
  });

  it('does not inspect or back up an idle running container', () => {
    assert.deepEqual(
      planLifecycleAlarm({
        hasManifest: true,
        containerRunning: true,
        status: 'running',
        activeBridgeConnections: 0
      }),
      {
        inspectRuntime: false,
        runBackup: false
      }
    );
  });

  it('backs up and inspects only when bridge connector activity is present', () => {
    assert.deepEqual(
      planLifecycleAlarm({
        hasManifest: true,
        containerRunning: true,
        status: 'running',
        activeBridgeConnections: 1
      }),
      {
        inspectRuntime: true,
        runBackup: true
      }
    );
  });

  it('renews container activity only when connector activity is present', () => {
    assert.equal(shouldRenewContainerActivity(0), false);
    assert.equal(shouldRenewContainerActivity(1), true);
  });
});
