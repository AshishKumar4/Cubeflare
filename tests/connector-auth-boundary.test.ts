import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('connector auth boundary', () => {
  it('keeps server invite commands separate from account CLI auth commands', () => {
    const app = readFileSync('src/react-app/App.tsx', 'utf8');
    const joinPanelStart = app.indexOf('function JoinPanel');
    const joinPanelEnd = app.indexOf('function CommandCopyRow');
    assert.notEqual(joinPanelStart, -1);
    assert.notEqual(joinPanelEnd, -1);

    const joinPanel = app.slice(joinPanelStart, joinPanelEnd);
    assert.match(joinPanel, /Secure local bridge/);
    assert.match(joinPanel, /Open bridge/);
    assert.match(joinPanel, /opens a bridge session and stays valid/);
    assert.match(joinPanel, /stays valid until you change or\s+regenerate/);
    assert.doesNotMatch(joinPanel, /does not sign anyone into|Cubeflare account/);
    assert.doesNotMatch(joinPanel, /It expires/);
    assert.doesNotMatch(joinPanel, /127\.0\.0\.1:25565|Run cubeflare connect/);
    assert.doesNotMatch(joinPanel, /Authorize once|Connect by name|authCommand|authenticatedCommand/);
  });

  it('does not model server invites as signed user login tokens', () => {
    const tokenTypes = readFileSync('src/worker/types.ts', 'utf8');
    assert.doesNotMatch(tokenTypes, /ConnectorTokenPayload|'cubeflare-cli-connect'|issuedByUserId/);
    assert.match(tokenTypes, /export type ConnectorInviteResponse/);
  });

  it('authorizes connector credentials only as server-scoped owner-issued invites', () => {
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const authorizeStart = worker.indexOf('async function authorizeConnectorRequest');
    const matchesStart = worker.indexOf('function connectorServerMatches');
    assert.notEqual(authorizeStart, -1);
    assert.notEqual(matchesStart, -1);

    const authorize = worker.slice(authorizeStart, matchesStart);
    assert.match(authorize, /normalizeConnectorInviteCode/);
    assert.match(authorize, /resolveServerInvite/);
    assert.match(authorize, /manifest\.ownerId !== invite\.ownerId/);
    assert.doesNotMatch(authorize, /verifyConnectorToken|payload\.issuedByUserId|payload\.userId|'cubeflare-cli-connect'/);
  });

  it('stores short invite codes by hash instead of raw code', () => {
    const identity = readFileSync('src/worker/durable/identity.ts', 'utf8');
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const tableStart = identity.indexOf('CREATE TABLE IF NOT EXISTS server_invites');
    const tableEnd = identity.indexOf(');', tableStart);
    assert.notEqual(tableStart, -1);
    assert.notEqual(tableEnd, -1);

    const inviteTable = identity.slice(tableStart, tableEnd);
    assert.match(inviteTable, /code_hash TEXT PRIMARY KEY/);
    assert.match(inviteTable, /kind TEXT NOT NULL/);
    assert.match(inviteTable, /expires_at TEXT/);
    assert.doesNotMatch(inviteTable, /expires_at TEXT NOT NULL/);
    assert.doesNotMatch(inviteTable, /invite_code|raw_code|\bcode TEXT\b/);
    assert.match(worker, /connectorInviteCodeHash/);
    assert.match(worker, /hmacSha256Hex\(secret, normalized\)/);
  });

  it('uses stable server-scoped invite codes instead of temporary random codes', () => {
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const createStart = worker.indexOf('async function createPersistentInviteCode');
    const normalizeStart = worker.indexOf('function normalizeConnectorInviteCode');
    assert.notEqual(createStart, -1);
    assert.notEqual(normalizeStart, -1);
    const creator = worker.slice(createStart, normalizeStart);

    assert.match(creator, /manifest\.serverId/);
    assert.match(creator, /manifest\.ownerId/);
    assert.match(creator, /invite\.prefix/);
    assert.match(creator, /invite\.rotation/);
    assert.doesNotMatch(creator, /crypto\.getRandomValues|Date\.now\(\) \+ .*INVITE_TTL/);
    assert.match(worker, /expiresAt: null/);
  });

  it('allows anonymous CLI invite codes without loading account config', () => {
    const cli = readFileSync('bin/cubeflare.mjs', 'utf8');
    const commandStart = cli.indexOf('async function commandConnect');
    const commandEnd = cli.indexOf('async function commandServers');
    assert.notEqual(commandStart, -1);
    assert.notEqual(commandEnd, -1);
    const command = cli.slice(commandStart, commandEnd);

    assert.match(command, /positionalIsInvite/);
    assert.match(command, /const inviteMode = positionalIsInvite \|\| Boolean\(args\.code\)/);
    assert.match(command, /const config = inviteMode \? null : await requireConfig\(\)/);
    assert.match(command, /Server invite code/);
    assert.doesNotMatch(command, /no account login is written|Cubeflare account/);
  });

  it('exposes invite prefix and rotation through the signed-in CLI management path', () => {
    const cli = readFileSync('bin/cubeflare.mjs', 'utf8');
    const worker = readFileSync('src/worker/index.ts', 'utf8');

    assert.match(cli, /subcommand === 'invite'/);
    assert.match(cli, /prefix: args\.prefix \|\| undefined/);
    assert.match(cli, /rotate: Boolean\(args\.rotate\)/);
    assert.match(cli, /\/api\/cli\/servers\/invite/);
    assert.match(worker, /app\.post\('\/api\/cli\/servers\/invite'/);
    assert.match(worker, /updateInviteForCli/);
    assert.match(worker, /registerPersistentConnectorInvite/);
  });

  it('does not expose owner log tails through invite diagnostics', () => {
    const worker = readFileSync('src/worker/index.ts', 'utf8');
    const diagnosticsStart = worker.indexOf('async function handleConnectorDiagnostics');
    const authorizeStart = worker.indexOf('async function authorizeConnectorRequest');
    assert.notEqual(diagnosticsStart, -1);
    assert.notEqual(authorizeStart, -1);

    const diagnostics = worker.slice(diagnosticsStart, authorizeStart);
    assert.match(diagnostics, /recentEvents/);
    assert.doesNotMatch(diagnostics, /processLogSnapshot|getProcessLogs|logs:/);
  });
});
