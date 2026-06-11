import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const root = process.cwd();
const cli = await import(pathToFileURL(path.join(root, 'public', 'downloads', 'cubeflare')).href);

describe('Cubeflare deploy CLI contract', () => {
  it('derives stable Worker and R2 resource names', () => {
    assert.deepEqual(cli.createDeployResourceNames({ workerName: 'cubeflare' }), {
      workerName: 'cubeflare',
      bucket: 'cubeflare'
    });
    assert.deepEqual(cli.createDeployResourceNames({ workerName: 'mine-host', bucket: 'custom-bucket' }), {
      workerName: 'mine-host',
      bucket: 'custom-bucket'
    });
  });

  it('rewrites generated Wrangler config without writing secrets into it', () => {
    const generated = {
      name: 'cubeflare',
      topLevelName: 'cubeflare',
      vars: {
        PREVIEW_DNS_READY: 'false',
        MC_DEFAULT_VERSION: '26.1.2'
      },
      r2_buckets: [],
      containers: [
        {
          class_name: 'MinecraftSandbox',
          image: '/repo/Dockerfile',
          name: 'cubeflare-minecraftsandbox'
        }
      ]
    };

    const config = cli.buildDeployWranglerConfig(generated, {
      workerName: 'mine-host',
      names: { bucket: 'mine-host' },
      publicBaseHost: 'https://minecraft.example.com/path',
      previewHostname: 'preview.minecraft.example.com',
      previewDnsReady: true
    });

    assert.equal(config.name, 'mine-host');
    assert.equal(config.topLevelName, 'mine-host');
    assert.deepEqual(config.r2_buckets, [{ binding: 'BUCKET', bucket_name: 'mine-host' }]);
    assert.equal(config.containers[0].name, 'mine-host-minecraftsandbox');
    assert.equal(config.vars.PUBLIC_BASE_HOST, 'minecraft.example.com');
    assert.equal(config.vars.PREVIEW_HOSTNAME, 'preview.minecraft.example.com');
    assert.equal(config.vars.PREVIEW_DNS_READY, 'true');
    assert.doesNotMatch(JSON.stringify(config), /R2_SECRET_ACCESS_KEY|CUBEFLARE_SECRET|R2_ACCESS_KEY_ID/);
  });

  it('parses Wrangler R2 bucket list output', () => {
    const output = [
      'name:           cubeflare-backups',
      'creation_date:  2026-06-02T21:19:02.976Z',
      '',
      'name:           cubeflare-dynmap'
    ].join('\n');
    assert.deepEqual(cli.parseWranglerBucketNames(output), ['cubeflare-backups', 'cubeflare-dynmap']);
  });

  it('does not rotate the Cubeflare root secret on ordinary redeploys', () => {
    const base = {
      accountId: 'account-id',
      names: { bucket: 'cubeflare' },
      r2Credentials: {
        accessKeyId: 'r2-access-key',
        secretAccessKey: 'r2-secret-key'
      },
      rootSecret: 'new-root-secret'
    };

    assert.equal(cli.createDeploySecrets({ ...base, rootSecretExists: true }).CUBEFLARE_SECRET, undefined);
    assert.equal(cli.createDeploySecrets({ ...base, rootSecretExists: true, rotateRootSecret: true }).CUBEFLARE_SECRET, 'new-root-secret');
    assert.equal(cli.createDeploySecrets({ ...base, rootSecretExists: false }).CUBEFLARE_SECRET, 'new-root-secret');
  });

  it('reuses existing Worker R2 credentials instead of rewriting them on redeploys', () => {
    const base = {
      accountId: 'account-id',
      names: { bucket: 'cubeflare' },
      rootSecretExists: true
    };

    const reused = cli.createDeploySecrets({ ...base, r2Credentials: null });
    assert.equal(reused.R2_ACCESS_KEY_ID, undefined);
    assert.equal(reused.R2_SECRET_ACCESS_KEY, undefined);
    assert.equal(reused.BACKUP_BUCKET_NAME, 'cubeflare');

    const written = cli.createDeploySecrets({
      ...base,
      r2Credentials: { accessKeyId: 'r2-access-key', secretAccessKey: 'r2-secret-key' }
    });
    assert.equal(written.R2_ACCESS_KEY_ID, 'r2-access-key');
    assert.equal(written.R2_SECRET_ACCESS_KEY, 'r2-secret-key');
  });

  it('guards undeploy behind explicit confirmation and tears everything down', () => {
    const source = readFileSync(path.join(root, 'public', 'downloads', 'cubeflare'), 'utf8');
    const start = source.indexOf('async function commandUndeploy');
    const end = source.indexOf('async function commandDoctor', start);
    assert.notEqual(start, -1);
    const undeploy = source.slice(start, end);

    assert.match(undeploy, /Type the worker name/);
    assert.match(undeploy, /Re-run with --yes to confirm/);
    assert.match(undeploy, /'wrangler', 'delete', '--name', workerName, '--force'/);
    assert.match(undeploy, /purgeR2Bucket\(/);
    const purgeIndex = undeploy.indexOf('purgeR2Bucket(');
    const bucketDeleteIndex = undeploy.indexOf("'r2', 'bucket', 'delete'");
    assert.ok(bucketDeleteIndex > purgeIndex, 'bucket must be purged before deletion');
  });

  it('does not expose old split auth secrets in deploy docs', () => {
    const docs = readFileSync('docs/deployment.md', 'utf8');
    assert.doesNotMatch(docs, /AUTH_PEPPER|INTERNAL_SHARED_SECRET|GATEWAY_SHARED_SECRET/);
  });
});
