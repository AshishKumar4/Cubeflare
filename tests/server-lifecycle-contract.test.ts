import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function methodBody(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

function methodBodyByPattern(source: string, startPattern: RegExp, endNeedle: string): string {
  const match = startPattern.exec(source);
  assert.ok(match?.index !== undefined, String(startPattern));
  const end = source.indexOf(endNeedle, match.index + match[0].length);
  assert.notEqual(end, -1);
  return source.slice(match.index, end);
}

describe('server lifecycle contract', () => {
  const sandboxSource = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

  it('deletes a server without creating a final backup', () => {
    const body = methodBody(
      sandboxSource,
      'async deleteServer',
      'listBackups(): BackupRecord[]'
    );

    assert.match(body, /setStatusValue\(["']deleting["']\)/);
    assert.match(body, /deleteBackupObjects\(existingBackups\)/);
    assert.doesNotMatch(body, /createBackupRecord|createAndStoreBackup|finalBackup/);
  });

  it('blocks active lifecycle operations once deletion starts', () => {
    assert.match(sandboxSource, /private assertNotDeleting\(\)/);
    for (const method of [
      'async startServer',
      'async backup',
      'async restore',
      'async executeRconCommand',
      'async getBridgeEndpoint',
      'async getDynmapPreview'
    ]) {
      const nextMethod = method === 'async getDynmapPreview' ? 'async getRuntimeStatus' : 'async ';
      const start = sandboxSource.indexOf(method);
      assert.notEqual(start, -1);
      const end = sandboxSource.indexOf(nextMethod, start + method.length);
      const body = sandboxSource.slice(start, end === -1 ? start + 800 : end);
      assert.match(body, /assertNotDeleting\(\)/, method);
    }
  });

  it('awaits periodic backups through the same backup coordinator as manual backups', () => {
    const lifecycleTick = methodBody(
      sandboxSource,
      'async lifecycleTick',
      'async writeManifest'
    );
    const backupMethod = methodBodyByPattern(
      sandboxSource,
      /async backup\(\s*reason = ["']manual-backup["']/,
      'async restore'
    );

    assert.match(
      lifecycleTick,
      /await this\.createAndStoreBackup\(\s*["']periodic["'],\s*\{\s*required: false\s*\}\s*\)/
    );
    assert.match(backupMethod, /await this\.createAndStoreBackup\(reason\)/);
    assert.doesNotMatch(sandboxSource, /queuePeriodicBackup/);
  });

  it('does not keep scheduling lifecycle ticks for idle running containers', () => {
    const lifecycleTick = methodBody(
      sandboxSource,
      'async lifecycleTick',
      'async writeManifest'
    );
    const idleBranchStart = lifecycleTick.indexOf('if (!decision.inspectRuntime)');
    assert.notEqual(idleBranchStart, -1);
    const activeBranchStart = lifecycleTick.indexOf('try {', idleBranchStart);
    assert.notEqual(activeBranchStart, -1);
    const idleBranch = lifecycleTick.slice(idleBranchStart, activeBranchStart);

    assert.match(idleBranch, /return/);
    assert.doesNotMatch(idleBranch, /scheduleLifecycleTick/);
    assert.match(lifecycleTick, /finally\s*\{\s*await this\.scheduleLifecycleTick\(\)/);
  });

  it('publishes a stopped snapshot when the container naturally stops', () => {
    const onStop = methodBody(
      sandboxSource,
      'override async onStop',
      'async recordConnectorActivity'
    );

    assert.match(onStop, /offlineRuntime\(manifest,\s*["']stopped["']\)/);
    assert.match(onStop, /this\.putJson\(["']summary["'],\s*summary\)/);
    assert.match(onStop, /await this\.syncUserSnapshot\(summary\)/);
    assert.doesNotMatch(onStop, /syncUserSnapshot\(summary\)\.catch/);
  });

  it('saves, stops Minecraft, then destroys the container before publishing stopped', () => {
    const stopServer = methodBody(
      sandboxSource,
      'async stopServer',
      'async restartServer'
    );

    assert.match(stopServer, /clearLifecycleTick\(\)/);
    assert.match(stopServer, /clearConnectorActivity\(\)/);
    assert.match(stopServer, /createAndStoreBackup\(reason,\s*\{\s*\n?\s*required:\s*false,?\s*\n?\s*\}\)/);
    assert.doesNotMatch(stopServer, /if \(!backup\) throw new Error\("Backup was not created"\)/);
    // A backup error must abort the stop before the container is destroyed.
    assert.doesNotMatch(stopServer, /catch\s*\{[^}]*backup = null/);
    assert.match(stopServer, /requestMinecraftStop\(\)/);
    const backupIndex = stopServer.indexOf('createAndStoreBackup');
    const killIndex = stopServer.indexOf('await this.killMinecraftProcesses()');
    const destroyIndex = stopServer.indexOf('await this.destroyStoppedContainer()', killIndex);
    const stoppedEventIndex = stopServer.indexOf('appendEvent("server.stopped"', destroyIndex);
    const finalSyncIndex = stopServer.lastIndexOf('await this.syncUserSnapshot(summary)');
    assert.ok(killIndex > backupIndex);
    assert.ok(destroyIndex > killIndex);
    assert.ok(stoppedEventIndex > destroyIndex);
    assert.ok(finalSyncIndex > stoppedEventIndex);
    assert.match(stopServer, /offlineRuntime\(this\.requireManifest\(\),\s*["']stopped["']\)/);
    assert.match(stopServer, /appendEvent\(["']server\.stopped["']/);
  });

  it('destroys an already-stopped warm container when Stop is requested again', () => {
    const stopServer = methodBody(
      sandboxSource,
      'async stopServer',
      'async restartServer'
    );
    const alreadyStoppedStart = stopServer.indexOf('if (current === "stopped")');
    const normalStopStart = stopServer.indexOf('this.setStatusValue("stopping")');
    assert.notEqual(alreadyStoppedStart, -1);
    assert.notEqual(normalStopStart, -1);
    const alreadyStoppedBranch = stopServer.slice(alreadyStoppedStart, normalStopStart);

    assert.match(alreadyStoppedBranch, /await this\.destroyStoppedContainer\(\)/);
    assert.match(alreadyStoppedBranch, /offlineRuntime\(manifest,\s*["']stopped["']\)/);
    assert.match(alreadyStoppedBranch, /clearConnectorActivity\(\)/);
  });

  it('uses the Sandbox SDK destroy path for explicit container teardown', () => {
    const destroyContainer = methodBody(
      sandboxSource,
      'private async destroyStoppedContainer',
      'private async killProcessAndWait'
    );

    assert.match(destroyContainer, /containerState\(\)\.container\?\.running !== true/);
    assert.match(destroyContainer, /await super\.destroy\(\)/);
  });

  it('confirms managed process termination before publishing stopped', () => {
    const killProcesses = methodBody(
      sandboxSource,
      'private async killMinecraftProcesses',
      'private async getMinecraftProcess'
    );

    assert.match(killProcesses, /MANAGED_PROCESS_IDS/);
    assert.match(killProcesses, /killProcessAndWait/);
    assert.match(killProcesses, /waitForProcessStopped/);
    assert.match(killProcesses, /process\.status !== "running"/);
    assert.match(killProcesses, /Process \$\{processId\} did not stop/);
  });

  it('verifies the bridge again after Minecraft and RCON are ready', () => {
    const waitForReady = methodBody(
      sandboxSource,
      'private async waitForMinecraftReady',
      'private async touchBridgeHealth'
    );

    assert.match(waitForReady, /"waiting_rcon"/);
    assert.match(waitForReady, /"checking_bridge"/);
    assert.match(waitForReady, /this\.touchBridgeHealth\(\)/);
    assert.match(waitForReady, /this\.ensureDynmapInitialRender\(\)/);
    assert.ok(waitForReady.indexOf('"checking_bridge"') > waitForReady.indexOf('"waiting_rcon"'));
    assert.ok(waitForReady.indexOf('ensureDynmapInitialRender') > waitForReady.indexOf('"checking_bridge"'));
  });

  it('queues a bounded initial Dynmap render after startup without failing server readiness', () => {
    const renderHelper = methodBody(
      sandboxSource,
      'private async ensureDynmapInitialRender',
      'private async queueDynmapRender'
    );

    assert.match(renderHelper, /manifest\.dynmap\.enabled/);
    assert.match(renderHelper, /DYNMAP_INITIAL_RENDER_KEY/);
    assert.match(sandboxSource, /private dynmapInitialRenderRadius\(\): number/);
    assert.match(sandboxSource, /parsePositiveInt\(/);
    assert.match(renderHelper, /dynmap radiusrender world 0 0/);
    assert.match(renderHelper, /dynmap\.initial_render_started/);
    assert.match(renderHelper, /dynmap\.initial_render_failed/);
    assert.doesNotMatch(renderHelper, /dynmap fullrender world/);
  });

  it('normalizes existing high-heap manifests before launch', () => {
    const startServer = methodBody(
      sandboxSource,
      'async startServer',
      'async stopServer'
    );
    const bootInner = methodBody(
      sandboxSource,
      'private async bootMinecraftInner',
      'private async startProcesses'
    );
    const normalizer = methodBody(
      sandboxSource,
      'private normalizedRuntimeManifest',
      'private async bootMinecraft'
    );

    assert.match(startServer, /normalizedRuntimeManifest\(this\.requireManifest\(\)\)/);
    assert.match(bootInner, /normalizedRuntimeManifest\(this\.requireManifest\(\)\)/);
    assert.match(normalizer, /normalizeManifestCompatibility\(manifest\)/);
    assert.match(normalizer, /normalizeMinecraftMemory\(compatibilityManifest\.memoryMin\)/);
    assert.match(normalizer, /normalizeMinecraftMemory\(compatibilityManifest\.memoryMax\)/);
    assert.match(normalizer, /server\.runtime_profile_adjusted/);
  });
});
