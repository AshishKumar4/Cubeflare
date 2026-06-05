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
