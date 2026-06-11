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
      'docs/assets/deploy-cli.svg',
      'docs/screenshots/landing.png',
      'docs/screenshots/dashboard.png'
    ]) {
      assert.equal(existsSync(path), true, `${path} should exist`);
    }

    const readme = readFileSync('README.md', 'utf8');
    assert.match(readme, /Cubeflare/);
    assert.match(readme, /docs\/assets\/deploy-cli\.svg/);
    assert.match(readme, /cubeflare deploy/);
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

  it('centralizes public host normalization instead of duplicating hostname fallbacks', () => {
    const hosts = readFileSync('src/worker/hosts.ts', 'utf8');
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');

    assert.match(hosts, /publicBaseHostForRequest/);
    assert.match(hosts, /publicBaseHostForManifest/);
    assert.match(hosts, /publicJoinHost/);
    assert.match(hosts, /internalBaseUrlForManifest/);
    assert.match(worker, /from '\.\/hosts'/);
    assert.match(sandbox, /from "\.\.\/hosts"/);
    assert.equal((worker.match(/function cleanHostValue/g) ?? []).length, 0);
    assert.equal((sandbox.match(/function cleanHostValue/g) ?? []).length, 0);
  });

  it('keeps the local CLI entrypoint as a wrapper around the downloadable CLI source', () => {
    const bin = readFileSync('bin/cubeflare.mjs', 'utf8');
    const download = readFileSync('public/downloads/cubeflare', 'utf8');

    assert.match(bin, /from '\.\.\/public\/downloads\/cubeflare'/);
    assert.match(bin, /runCli\(\)/);
    assert.match(download, /export function runCli/);
    assert.doesNotMatch(bin, /async function commandConnect|async function commandAuth/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
