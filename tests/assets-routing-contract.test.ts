import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('Workers Assets routing contract', () => {
  it('runs Worker routes before SPA asset fallback for operational paths', () => {
    const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const runWorkerFirst = config.assets?.run_worker_first;

    assert.ok(Array.isArray(runWorkerFirst));
    assert.ok(runWorkerFirst.includes('/api/*'));
    assert.ok(runWorkerFirst.includes('/internal/*'));
    assert.ok(runWorkerFirst.includes('/map/*'));
    assert.ok(runWorkerFirst.includes('/install.sh'));
    assert.ok(runWorkerFirst.includes('/downloads/*'));
    assert.equal(config.assets?.binding, 'ASSETS');
    assert.equal(config.assets?.not_found_handling, 'single-page-application');
  });

  it('keeps the public deploy template free of account-specific routes and domains', () => {
    const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const serialized = JSON.stringify(config);

    assert.equal(config.routes, undefined);
    assert.doesNotMatch(serialized, /ashishkumarsingh|minecraft\.ashish|f44999d1/);
    assert.equal(config.vars?.PUBLIC_BASE_HOST, undefined);
    assert.equal(config.vars?.PREVIEW_HOSTNAME, undefined);
    assert.equal(config.vars?.CLOUDFLARE_ACCOUNT_ID, undefined);
  });

  it('serves installer assets through the Worker so self-hosted deployments inject their own origin', () => {
    const source = readFileSync('src/worker/index.ts', 'utf8');

    assert.match(source, /app\.get\('\/install\.sh'/);
    assert.match(source, /app\.get\('\/downloads\/cubeflare'/);
    assert.match(source, /rewriteInstallScript/);
    assert.match(source, /rewriteCliDownload/);
    assert.match(source, /new URL\(c\.req\.url\)\.origin/);
  });
});
