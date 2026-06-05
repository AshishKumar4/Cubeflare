import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanMinecraftLocationPreference,
  durableObjectLocationHint,
  minecraftLocationLabel
} from '../src/shared/minecraft-locations.ts';

describe('Minecraft location preferences', () => {
  it('accepts Cloudflare Durable Object location hints', () => {
    assert.equal(cleanMinecraftLocationPreference('wnam'), 'wnam');
    assert.equal(cleanMinecraftLocationPreference('weur'), 'weur');
    assert.equal(durableObjectLocationHint('apac'), 'apac');
  });

  it('falls back to automatic placement for invalid input', () => {
    assert.equal(cleanMinecraftLocationPreference('us-east'), 'auto');
    assert.equal(cleanMinecraftLocationPreference(undefined), 'auto');
    assert.equal(durableObjectLocationHint('auto'), undefined);
  });

  it('exposes operator-friendly labels', () => {
    assert.equal(minecraftLocationLabel('me'), 'Middle East');
    assert.equal(minecraftLocationLabel('unknown'), 'Automatic');
  });
});
