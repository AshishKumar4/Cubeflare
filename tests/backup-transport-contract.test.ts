import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('backup transport contract', () => {
  it('does not configure localBucket backups in production wrangler config', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');

    assert.doesNotMatch(config, /BACKUP_USE_LOCAL_BUCKET/);
  });

  it('creates backups through the Sandbox SDK production transport', () => {
    const source = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.doesNotMatch(source, /localBucket\s*:/);
    assert.doesNotMatch(source, /useLocalBucketBackups/);
  });
});
