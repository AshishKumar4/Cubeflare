import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  minecraftBackupExcludes,
  shouldBackupMinecraftPath
} from '../src/worker/minecraft/backup-policy.ts';

describe('Minecraft backup scope policy', () => {
  it('excludes immutable runtime artifacts from server backups', () => {
    const excluded = [
      'server.jar',
      'libraries/org/xerial/sqlite-jdbc.jar',
      'versions/26.1.2/paper-26.1.2.jar',
      'cache/mojang_1.21.8.jar',
      'logs/latest.log',
      'crash-reports/crash.txt',
      '.paper-remapped/server.jar',
      '.cubeflare/manifest.json',
      'plugins/dynmap/web/tiles/world/flat/0_0/zzzzz_0_0.jpg',
      'plugins/dynmap/web/tiles/_markers_/marker_world.json'
    ];

    for (const path of excluded) {
      assert.equal(shouldBackupMinecraftPath(path), false, path);
    }
  });

  it('keeps mutable gameplay state in server backups', () => {
    const included = [
      'world/region/r.0.0.mca',
      'world_nether/DIM-1/region/r.0.0.mca',
      'server.properties',
      'ops.json',
      'whitelist.json',
      'banned-players.json',
      'plugins/LuckPerms.jar',
      'plugins/LuckPerms/config.yml',
      'plugins/dynmap/configuration.txt',
      'mods/fabric-api.jar',
      'datapacks/custom.zip',
      'resource-pack.zip'
    ];

    for (const path of included) {
      assert.equal(shouldBackupMinecraftPath(path), true, path);
    }
  });

  it('passes mksquashfs-compatible exclude patterns to the Sandbox SDK', () => {
    const excludes = minecraftBackupExcludes();

    assert.equal(excludes.includes('server.jar'), true);
    assert.equal(excludes.includes('libraries'), true);
    assert.equal(excludes.includes('versions'), true);
    assert.equal(excludes.includes('plugins/dynmap/web/tiles'), true);
    assert.equal(excludes.some((pattern) => pattern.includes('**')), false);
  });
});
