import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DEFAULT_MEMORY_MAX,
  DEFAULT_MEMORY_MIN,
  DEFAULT_SIMULATION_DISTANCE,
  DEFAULT_VIEW_DISTANCE,
  defaultJavaConfig,
  normalizeMinecraftMemory
} from '../src/shared/minecraft-optimization.ts';

describe('Minecraft runtime optimization defaults', () => {
  it('uses high-fidelity gameplay defaults for new servers', () => {
    assert.equal(DEFAULT_MEMORY_MIN, '10G');
    assert.equal(DEFAULT_MEMORY_MAX, '10G');
    assert.equal(DEFAULT_VIEW_DISTANCE, 12);
    assert.equal(DEFAULT_SIMULATION_DISTANCE, 10);
  });

  it('uses tuned G1 flags for high-performance server presets', () => {
    assert.equal(defaultJavaConfig('paper').flagsProfile, 'aikar-g1');
    assert.equal(defaultJavaConfig('purpur').flagsProfile, 'aikar-g1');
    assert.equal(defaultJavaConfig('folia').flagsProfile, 'aikar-g1');
    assert.equal(defaultJavaConfig('vanilla').flagsProfile, 'modern-g1');
  });

  it('caps configured Java heap to the container-safe profile', () => {
    assert.equal(normalizeMinecraftMemory('11G'), '10G');
    assert.equal(normalizeMinecraftMemory('11264M'), '10G');
    assert.equal(normalizeMinecraftMemory('10240M'), '10240M');
    assert.equal(normalizeMinecraftMemory('8G'), '8G');
    assert.equal(normalizeMinecraftMemory('bad'), DEFAULT_MEMORY_MIN);
  });

  it('starts Minecraft from generated Java args instead of global tool options', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const runner = readFileSync('container/bin/cubeflare-run-server.sh', 'utf8');
    const preparer = readFileSync('container/bin/cubeflare-prepare-server.mjs', 'utf8');

    assert.match(dockerfile, /JAVA_TOOL_OPTIONS=""/);
    assert.match(runner, /JAVA_ARGS_FILE/);
    assert.match(preparer, /writeJavaArgs/);
    assert.match(preparer, /-Dusing\.aikars\.flags=https:\/\/mcflags\.emc\.gs/);
  });
});
