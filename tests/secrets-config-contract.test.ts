import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('Cubeflare secret configuration contract', () => {
  it('uses one operator-facing Cubeflare root secret for app auth material', () => {
    const types = readFileSync('src/worker/types.ts', 'utf8');
    const auth = readFileSync('src/worker/auth.ts', 'utf8');
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const secrets = readFileSync('src/worker/secrets.ts', 'utf8');

    assert.match(types, /CUBEFLARE_SECRET\?: string/);
    assert.doesNotMatch(types, /AUTH_PEPPER|INTERNAL_SHARED_SECRET|GATEWAY_SHARED_SECRET/);
    assert.match(auth, /authPasswordPepper/);
    assert.match(worker, /cliTokenSecret/);
    assert.match(worker, /connectorInviteSecret/);
    assert.match(worker, /connectorActivitySecret/);
    assert.match(worker, /minecraftBridgeSecret/);
    assert.match(worker, /dynmapSyncSecret/);
    assert.match(secrets, /auth\.password-pepper/);
    assert.match(secrets, /cli\.token-signing/);
    assert.match(secrets, /connector\.invite-codes/);
    assert.match(secrets, /connector\.activity/);
    assert.match(secrets, /minecraft\.bridge/);
    assert.match(secrets, /dynmap\.sync/);
  });

  it('keeps direct R2 S3 credentials only for Sandbox SDK backup and restore transport', () => {
    const envExample = readFileSync('.dev.vars.example', 'utf8');
    const backupContract = readFileSync('tests/backup-transport-contract.test.ts', 'utf8');

    assert.match(envExample, /CUBEFLARE_SECRET/);
    assert.match(envExample, /R2_ACCESS_KEY_ID/);
    assert.match(envExample, /R2_SECRET_ACCESS_KEY/);
    assert.match(envExample, /BACKUP_BUCKET_NAME/);
    assert.match(envExample, /CLOUDFLARE_ACCOUNT_ID/);
    assert.match(envExample, /BACKUP_BUCKET_ENDPOINT/);
    assert.doesNotMatch(envExample, /AUTH_PEPPER|INTERNAL_SHARED_SECRET|GATEWAY_SHARED_SECRET/);
    assert.doesNotMatch(envExample, /CUBEFLARE_WORKER_ORIGIN|^PORT=/m);
    assert.doesNotMatch(envExample, /replace-with|production-|ashishkumarsingh|minecraft\.ashish/);
    assert.match(envExample, /^CUBEFLARE_SECRET=$/m);
    assert.match(envExample, /^R2_ACCESS_KEY_ID=$/m);
    assert.match(envExample, /^R2_SECRET_ACCESS_KEY=$/m);
    assert.match(backupContract, /Sandbox SDK production transport/);
  });

  it('passes explicit bridge and Dynmap secrets into the container process', () => {
    const sandbox = readFileSync('src/worker/sandbox/MinecraftSandbox.ts', 'utf8');
    const bridge = readFileSync('container/bin/cubeflare-ws-bridge.mjs', 'utf8');
    const dynmapSync = readFileSync('container/bin/cubeflare-dynmap-sync.mjs', 'utf8');

    assert.match(sandbox, /CUBEFLARE_BRIDGE_SECRET/);
    assert.match(sandbox, /CUBEFLARE_DYNMAP_SYNC_SECRET/);
    assert.match(bridge, /CUBEFLARE_BRIDGE_SECRET/);
    assert.match(bridge, /CUBEFLARE_DYNMAP_SYNC_SECRET/);
    assert.match(dynmapSync, /CUBEFLARE_DYNMAP_SYNC_SECRET/);
    assert.doesNotMatch(sandbox, /INTERNAL_SHARED_SECRET|AUTH_PEPPER/);
    assert.doesNotMatch(bridge, /INTERNAL_SHARED_SECRET|AUTH_PEPPER/);
    assert.doesNotMatch(dynmapSync, /INTERNAL_SHARED_SECRET|AUTH_PEPPER/);
  });
});
