import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('release hygiene contract', () => {
  it('ships the public-facing project documents needed for a release', () => {
    for (const path of [
      'README.md',
      'LICENSE',
      'SECURITY.md',
      'docs/deployment.md',
      'docs/screenshots/landing.png',
      'docs/screenshots/dashboard.png'
    ]) {
      assert.equal(existsSync(path), true, `${path} should exist`);
    }

    const readme = readFileSync('README.md', 'utf8');
    assert.match(readme, /Cubeflare/);
    assert.match(readme, /deploy\.workers\.cloudflare\.com\/button/);
    assert.match(readme, /https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/AshishKumar4\/Cubeflare/);
    assert.match(readme, /docs\/screenshots\/landing\.png/);
    assert.match(readme, /docs\/screenshots\/dashboard\.png/);
    assert.match(readme, /Architecture/);
    assert.match(readme, /Requirements/);
    assert.match(readme, /Deploy/);
    assert.match(readme, /release:check/);
  });

  it('keeps generated and reference-only local artifacts out of the repository', () => {
    const gitignore = readFileSync('.gitignore', 'utf8');

    for (const pattern of [
      'dist/',
      'node_modules/',
      '.wrangler/',
      '.dev.vars',
      '.env',
      'worker-configuration.d.ts',
      'sandbox-sdk/',
      'externals/sandbox-sdk/'
    ]) {
      assert.match(gitignore, new RegExp(escapeRegExp(pattern)));
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
