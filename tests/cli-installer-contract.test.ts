import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Cubeflare CLI installer contract', () => {
  it('installs an extensionless PATH command backed by an ESM module', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cubeflare-installer-'));
    const installDir = path.join(home, '.local', 'bin');

    try {
      const install = spawnSync('sh', ['public/install.sh'], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          CUBEFLARE_INSTALL_BASE_URL: `file://${path.join(root, 'public')}`,
          CUBEFLARE_INSTALL_DIR: installDir,
          CUBEFLARE_UPDATE_PROFILE: '0'
        },
        encoding: 'utf8'
      });
      assert.equal(install.status, 0, install.stderr || install.stdout);

      const cubeflare = spawnSync(path.join(installDir, 'cubeflare'), ['help'], {
        encoding: 'utf8'
      });
      assert.equal(cubeflare.status, 0, cubeflare.stderr || cubeflare.stdout);
      assert.match(cubeflare.stdout, /Cubeflare CLI/);

      const connect = spawnSync(path.join(installDir, 'cubeflare'), ['connect', '--help'], {
        encoding: 'utf8'
      });
      assert.equal(connect.status, 0, connect.stderr || connect.stdout);
      assert.match(connect.stdout, /Usage: cubeflare connect/);
      assert.equal(existsSync(path.join(installDir, ['cubeflare', 'connect'].join('-'))), false);
      const wrapper = readFileSync(path.join(installDir, 'cubeflare'), 'utf8');
      assert.match(wrapper, /CUBEFLARE_DEFAULT_ORIGIN=/);
      assert.match(wrapper, /file:\/\/.*\/public/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('can bootstrap the CLI before a Cubeflare Worker exists', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cubeflare-bootstrap-installer-'));
    const installDir = path.join(home, '.local', 'bin');

    try {
      const install = spawnSync('sh', ['public/install.sh'], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          CUBEFLARE_CLI_DOWNLOAD_URL: `file://${path.join(root, 'public', 'downloads', 'cubeflare')}`,
          CUBEFLARE_INSTALL_DIR: installDir,
          CUBEFLARE_UPDATE_PROFILE: '0'
        },
        encoding: 'utf8'
      });
      assert.equal(install.status, 0, install.stderr || install.stdout);
      assert.match(install.stdout, /cubeflare deploy/);

      const cubeflare = spawnSync(path.join(installDir, 'cubeflare'), ['deploy', '--help'], {
        encoding: 'utf8'
      });
      assert.equal(cubeflare.status, 0, cubeflare.stderr || cubeflare.stdout);
      assert.match(cubeflare.stdout, /Usage: cubeflare deploy/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
