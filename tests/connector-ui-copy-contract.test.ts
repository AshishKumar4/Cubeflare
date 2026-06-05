import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('connector UI copy contract', () => {
  const source = readFileSync('src/react-app/App.tsx', 'utf8');

  it('does not label connector activity as verified Minecraft players', () => {
    assert.match(source, /label="Bridge"/);
    assert.match(source, /Player activity/);
    assert.match(source, /Minecraft players online/);
    assert.match(source, /active bridge connections/);
    assert.doesNotMatch(source, /label="Players" value=\{String\(fleetStats/);
    assert.doesNotMatch(source, /No players online/);
  });

  it('presents the CLI bridge instead of the internal server alias', () => {
    const joinPanelStart = source.indexOf('function JoinPanel');
    const commandRowStart = source.indexOf('function CommandCopyRow');
    assert.notEqual(joinPanelStart, -1);
    assert.notEqual(commandRowStart, -1);

    const joinPanel = source.slice(joinPanelStart, commandRowStart);
    assert.match(joinPanel, /Secure local bridge/);
    assert.match(joinPanel, /Open bridge/);
    assert.match(source, /Set up a secure bridge/);
    assert.match(source, /The CLI chooses an available local port and prints the Minecraft address to join/);
    assert.doesNotMatch(joinPanel, /127\.0\.0\.1:25565|Run cubeflare connect/);
    assert.doesNotMatch(joinPanel, /compactJoinHost|joinHost|joinAddress|summary\.joinHost/);
    assert.doesNotMatch(source, /\['Join host'/);
    assert.doesNotMatch(source, /server\.joinHost/);
    assert.doesNotMatch(source, /\['Minecraft address', '127\.0\.0\.1:25565'\]/);
  });

  it('exposes custom invite prefix controls without letting the UI set the full secret code', () => {
    assert.match(source, /Invite prefix/);
    assert.match(source, /Regenerate invite code/);
    assert.match(source, /invite: \{ prefix: draft\.invitePrefix \}/);
    assert.match(source, /invite: \{ rotate: true \}/);
    assert.doesNotMatch(source, /rawInviteCode|customInviteCode|setInviteCode/);
  });
});
