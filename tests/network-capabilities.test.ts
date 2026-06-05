import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCANNED_ROOTS = ['src', 'container', 'bin', 'docs'];
const FORBIDDEN_REFERENCES = [
  'play' + 'it',
  'tail' + 'scale',
  'cloudflare' + '-tunnel',
  'cloudflare' + 'Tunnel',
  'CUBEFLARE_' + 'PLAYIT'
];

describe('network capability surface', () => {
  it('does not expose unsupported network or tunnel providers', () => {
    const matches: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const reference of FORBIDDEN_REFERENCES) {
        if (text.includes(reference)) {
          matches.push(`${file}: ${reference}`);
        }
      }
    }
    assert.deepEqual(matches, []);
  });
});

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    walk(root, files);
  }
  return files;
}

function walk(path: string, files: string[]): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(join(path, entry), files);
    }
    return;
  }
  if (/\.(ts|tsx|js|mjs|md|jsonc?)$/.test(path)) {
    files.push(path);
  }
}
