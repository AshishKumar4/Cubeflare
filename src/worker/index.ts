import { ContainerProxy, getSandbox, proxyToSandbox, type Sandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { authenticateRequest, loginUser, logoutUser, registerUser, requireAuth, setSessionCookie } from './auth';
import {
  createConnectorActivityToken,
  createBridgeToken,
  createCliToken,
  verifyConnectorActivityToken,
  verifyBridgeToken,
  verifyCliToken
} from './connect-tokens';
import { randomBase64Url, hmacSha256Hex, sha256Hex, timingSafeEqual } from './crypto';
import { IdentityRegistryDO } from './durable/identity';
import { UserDO } from './durable/user';
import { dynmapSecurityHeaders, HttpError, isSafeOrigin, parseJson, problem, strictSecurityHeaders } from './http';
import { configuredPreviewHostname, publicBaseHostForRequest, publicJoinHost } from './hosts';
import { createServerId } from './minecraft/ids';
import { BUILTIN_PLUGINS, buildManifest, normalizeInviteConfig } from './minecraft/presets';
import { DEFAULT_MINECRAFT_VERSION, getVersionCatalog } from './minecraft/versions';
import { MinecraftSandbox } from './sandbox/MinecraftSandbox';
import {
  cliTokenSecret,
  connectorActivitySecret,
  connectorInviteSecret,
  dynmapSyncSecret,
  minecraftBridgeSecret
} from './secrets';
import {
  cleanMinecraftLocationPreference,
  durableObjectLocationHint,
  type MinecraftLocationPreference
} from '../shared/minecraft-locations';
import { DEFAULT_MEMORY_MAX, DEFAULT_MEMORY_MIN } from '../shared/minecraft-optimization';
import { builtinDynmapCompatibility } from '../shared/minecraft-map';
import type {
  AppEnv,
  ConnectorActivityRequest,
  ConnectorDiagnosticsResponse,
  ConnectorInviteResponse,
  ConnectorProgressResponse,
  ConnectorSessionRequest,
  CliAuthPollResponse,
  CliAuthStartResponse,
  CliServerListResponse,
  HonoBindings,
  MinecraftServerManifest,
  RuntimeLocationObservation,
  ServerCreateRequest,
  ServerPatchRequest,
  ServerSummary
} from './types';

export { ContainerProxy, IdentityRegistryDO, MinecraftSandbox, UserDO };

const app = new Hono<HonoBindings>();
const LOCAL_CONNECT_ADDRESS = '127.0.0.1:<auto>';
const BRIDGE_TOKEN_TTL_SECONDS = 2 * 60;
const CONNECTOR_ACTIVITY_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const CLI_AUTH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const CLI_DEVICE_AUTH_TTL_SECONDS = 10 * 60;
const CLI_DEVICE_AUTH_INTERVAL_SECONDS = 2;
const MINECRAFT_BRIDGE_PORT = 25566;
const BRIDGE_PREVIEW_TOKEN = 'mcbridge';
const PREVIEW_PROXY_HEADER = 'x-sandbox-preview-proxy';
const PREVIEW_PROXY_PORT_HEADER = 'x-sandbox-preview-port';
const PREVIEW_PROXY_TOKEN_HEADER = 'x-sandbox-preview-token';
const PREVIEW_PROXY_SANDBOX_ID_HEADER = 'x-sandbox-preview-sandbox-id';
const FILE_JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const FILE_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;
const PLUGIN_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024;
const CONNECTOR_INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CONNECTOR_INVITE_SUFFIX_LENGTH = 16;
const CONNECTOR_INVITE_SUFFIX_GROUPS = 4;

app.use('*', async (c, next) => {
  await next();
  if (c.req.path.startsWith('/map/')) return;
  c.res = strictSecurityHeaders(c.res);
});

app.onError((error) => {
  if (error instanceof HttpError) {
    return problem(error.status, error.code, error.message, error.detail);
  }
  return problem(500, 'internal_error', error instanceof Error ? error.message : String(error));
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    name: 'cubeflare',
    time: new Date().toISOString()
  })
);

app.get('/install.sh', async (c) =>
  serveTextAsset(c, '/install.sh', 'text/x-shellscript; charset=utf-8', rewriteInstallScript)
);

app.get('/downloads/cubeflare', async (c) =>
  serveTextAsset(c, '/downloads/cubeflare', 'text/javascript; charset=utf-8', rewriteCliDownload)
);

app.get('/api/presets', async (c) => {
  const versions = await getVersionCatalog();
  return c.json({
    presets: ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'custom'],
    versions,
    defaultVersions: {
      vanilla: defaultVersionFor(versions.vanilla),
      paper: defaultVersionFor(versions.paper),
      purpur: defaultVersionFor(versions.purpur),
      folia: defaultVersionFor(versions.folia),
      fabric: defaultVersionFor(versions.fabric),
      custom: DEFAULT_MINECRAFT_VERSION
    },
    paperVersions: versions.paper,
    builtinPlugins: BUILTIN_PLUGINS
  });
});

app.get('/api/me', async (c) => {
  const user = await authenticateRequest(c);
  return c.json({ user });
});

app.post('/api/auth/register', async (c) => {
  if (!isSafeOrigin(c.req.raw)) {
    return problem(403, 'bad_origin', 'Registration must come from the same origin');
  }
  const body = await parseJson<{ email: string; password: string; displayName?: string }>(c.req.raw);
  const session = await registerUser(c.env, body, c.req.raw);
  setSessionCookie(c, session.cookieToken, session.expiresAt);
  return c.json({ user: session.user });
});

app.post('/api/auth/login', async (c) => {
  if (!isSafeOrigin(c.req.raw)) {
    return problem(403, 'bad_origin', 'Login must come from the same origin');
  }
  const body = await parseJson<{ email: string; password: string }>(c.req.raw);
  const session = await loginUser(c.env, body, c.req.raw);
  setSessionCookie(c, session.cookieToken, session.expiresAt);
  return c.json({ user: session.user });
});

app.post('/api/auth/logout', requireAuth(), async (c) => {
  await logoutUser(c);
  return c.json({ ok: true });
});

app.get('/api/servers', requireAuth(), async (c) => {
  const user = c.get('user');
  const servers = await c.env.USER_DO.getByName(user.userId).listServers();
  return c.json({ servers });
});

app.post('/api/servers', requireAuth(), async (c) => {
  const user = c.get('user');
  const request = await parseJson<ServerCreateRequest>(c.req.raw);
  const serverId = createServerId(request.name);
  const manifest = buildManifest({
    serverId,
    ownerId: user.userId,
    request,
    defaults: {
      version: c.env.MC_DEFAULT_VERSION ?? DEFAULT_MINECRAFT_VERSION,
      memoryMin: c.env.MC_DEFAULT_MEMORY_MIN ?? DEFAULT_MEMORY_MIN,
      memoryMax: c.env.MC_DEFAULT_MEMORY_MAX ?? DEFAULT_MEMORY_MAX,
      baseHost: publicBaseHostForRequest(c.env, c.req.raw)
    }
  });
  const requestLocation = requestLocationObservation(c.req.raw);
  if (requestLocation) {
    manifest.location.actual = requestLocation;
  }
  const server = await minecraftSandboxById(c.env, serverId, manifest.location.preference);
  const summary = await server.create(manifest);
  await c.env.USER_DO.getByName(user.userId).addServer(summary);
  c.executionCtx.waitUntil(server.startServer('server-created').catch(() => undefined));
  return c.json({ server: summary, manifest }, 201);
});

app.get('/api/servers/:serverId', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  return c.json({
    summary: await server.getSummary(),
    manifest: await server.getManifest(),
    backups: await server.listBackups(),
    events: await server.recentEvents(40)
  });
});

app.patch('/api/servers/:serverId', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await parseJson<ServerPatchRequest>(c.req.raw);
  const summary = await server.patch(body);
  const manifest = await server.getManifest();
  if (manifest && body.invite) {
    await registerPersistentConnectorInvite(c.env, manifest);
  }
  return c.json({ summary, manifest });
});

app.delete('/api/servers/:serverId', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  return c.json(await server.deleteServer('user-delete'));
});

app.post('/api/servers/:serverId/start', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  try {
    return c.json(await server.startServer('user-start'));
  } catch (error) {
    throw await lifecycleHttpError(c.env, server, 'server_start_failed', 'Server start failed', error);
  }
});

app.post('/api/servers/:serverId/stop', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  return c.json(await server.stopServer('user-stop'));
});

app.post('/api/servers/:serverId/restart', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  try {
    return c.json(await server.restartServer('user-restart'));
  } catch (error) {
    throw await lifecycleHttpError(c.env, server, 'server_restart_failed', 'Server restart failed', error);
  }
});

app.get('/api/servers/:serverId/status', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  c.executionCtx.waitUntil(recordRequestLocation(c.req.raw, server));
  return c.json({ runtime: await server.runtimeStatus(), summary: await server.getSummary() });
});

app.post('/api/servers/:serverId/connect-invite', requireAuth(), async (c) => {
  const user = c.get('user');
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), user.userId);
  return c.json(await createConnectorInviteForUser(c.env, c.req.url, manifest, user.userId));
});

app.get('/api/servers/:serverId/diagnostics', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  const manifest = await server.getManifest();
  if (!manifest) throw new HttpError(404, 'not_found', 'Server not found');
  return c.json({
    summary: await server.getSummary(),
    runtime: await server.runtimeStatus(),
    events: await server.recentEvents(12),
    logs: await withTimeout(
      processLogSnapshot(c.env, manifest),
      5_000,
      'Process snapshot'
    ).catch((error: unknown) => ({
      processId: 'minecraft-server',
      stdoutTail: '',
      stderrTail: errorMessage(error),
      processes: [
        {
          processId: 'minecraft-server',
          status: null,
          exitCode: null,
          stdoutTail: '',
          stderrTail: errorMessage(error)
        }
      ]
    })),
    dynmapRuntime: await withTimeout(
      server.getDynmapRuntimeStatus(),
      5_000,
      'Dynmap runtime status'
    ).catch((error: unknown) => ({
      ok: false,
      error: errorMessage(error)
    }))
  });
});

app.post('/api/servers/:serverId/backups', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await optionalJson<{ reason?: string }>(c.req.raw);
  return c.json({ backup: await server.backup(body?.reason ?? 'user-backup') });
});

app.get('/api/servers/:serverId/backups', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  return c.json({ backups: await server.listBackups() });
});

app.post('/api/servers/:serverId/backups/:backupId/restore', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  try {
    return c.json(await server.restore(c.req.param('backupId')));
  } catch (error) {
    throw await lifecycleHttpError(c.env, server, 'server_restore_failed', 'Server restore failed', error);
  }
});

app.get('/api/servers/:serverId/logs', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const logs = await (await minecraftSandbox(c.env, manifest)).getProcessLogs('minecraft-server').catch(() => ({
    stdout: '',
    stderr: 'Minecraft process has not started yet',
    processId: 'minecraft-server'
  }));
  return c.json({ logs });
});

app.get('/api/servers/:serverId/logs/stream', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const sandbox = await minecraftSandbox(c.env, manifest);
  const stream = createMinecraftLogStream(sandbox);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    }
  });
});

app.get('/api/servers/:serverId/terminal', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const sandbox = await readyMinecraftSandbox(c.env, manifest, 'terminal');
  const sessionId = `terminal-${manifest.serverId}`;
  const session = await sandbox.createSession({ id: sessionId, cwd: '/workspace/server' }).catch((error) => {
    if (isSessionAlreadyExists(error)) return sandbox.getSession(sessionId);
    throw error;
  });
  const url = new URL(c.req.url);
  return session.terminal(c.req.raw, {
    cols: parseTerminalDimension(url.searchParams.get('cols'), 120, 40, 240),
    rows: parseTerminalDimension(url.searchParams.get('rows'), 34, 12, 80),
    shell: '/bin/bash'
  });
});

app.post('/api/servers/:serverId/rcon', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await parseJson<{ command: string }>(c.req.raw);
  if (!body.command || body.command.length > 500) {
    throw new HttpError(400, 'invalid_command', 'Command is required');
  }
  return c.json(await server.executeRconCommand(body.command));
});

app.get('/api/servers/:serverId/files', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const path = safeServerPath(c.req.query('path') ?? '.');
  const listing = await (await readyMinecraftSandbox(c.env, manifest, 'file-list')).listFiles(path, { includeHidden: true });
  const files = listing.files.filter((file) => !isInternalServerPath(file.absolutePath ?? file.relativePath ?? file.name));
  return c.json({
    files,
    count: files.length,
    path: listing.path || path,
    timestamp: listing.timestamp
  });
});

app.get('/api/servers/:serverId/files/changes', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const path = safeServerPath(c.req.query('path') ?? '.');
  const since = c.req.query('since');
  const changes = await (await readyMinecraftSandbox(c.env, manifest, 'file-changes')).checkChanges(path, {
    recursive: true,
    since: since || undefined
  });
  return c.json({ changes, path });
});

app.get('/api/servers/:serverId/files/content', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const path = safeServerPath(c.req.query('path') ?? '');
  const file = await (await readyMinecraftSandbox(c.env, manifest, 'file-read')).readFile(path, { encoding: 'utf-8' });
  return c.json(file);
});

app.put('/api/servers/:serverId/files/content', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await parseJson<{ path: string; content: string }>(c.req.raw, {
    maxBytes: FILE_JSON_BODY_LIMIT_BYTES
  });
  await (await readyMinecraftSandbox(c.env, manifest, 'file-write')).writeFile(safeServerPath(body.path), body.content);
  return c.json({ ok: true });
});

app.post('/api/servers/:serverId/files/mkdir', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await parseJson<{ path: string }>(c.req.raw);
  const path = safeServerPath(body.path);
  await (await readyMinecraftSandbox(c.env, manifest, 'file-mkdir')).mkdir(path, { recursive: true });
  return c.json({ ok: true, path });
});

app.post('/api/servers/:serverId/files/move', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await parseJson<{ sourcePath: string; destinationPath: string }>(c.req.raw);
  const sourcePath = safeServerPath(body.sourcePath);
  const destinationPath = safeServerPath(body.destinationPath);
  await (await readyMinecraftSandbox(c.env, manifest, 'file-move')).moveFile(sourcePath, destinationPath);
  return c.json({ ok: true, sourcePath, destinationPath });
});

app.post('/api/servers/:serverId/files/upload', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const directory = safeServerPath(c.req.query('path') ?? '.');
  const filename = cleanGenericFilename(c.req.query('filename') ?? 'upload.bin');
  if (!c.req.raw.body) throw new HttpError(400, 'missing_body', 'File upload body is required');
  assertContentLengthWithin(c.req.raw, FILE_UPLOAD_LIMIT_BYTES, 'file_too_large');
  const targetPath = `${directory}/${filename}`;
  await (await readyMinecraftSandbox(c.env, manifest, 'file-upload')).writeFile(
    targetPath,
    limitBodyStream(c.req.raw.body, FILE_UPLOAD_LIMIT_BYTES)
  );
  return c.json({ ok: true, path: targetPath, filename });
});

app.delete('/api/servers/:serverId/files', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const body = await parseJson<{ path: string }>(c.req.raw);
  await (await readyMinecraftSandbox(c.env, manifest, 'file-delete')).deleteFile(safeServerPath(body.path));
  return c.json({ ok: true });
});

app.post('/api/servers/:serverId/plugins/upload', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const filename = cleanPluginFilename(c.req.query('filename') ?? 'plugin.jar');
  if (!c.req.raw.body) throw new HttpError(400, 'missing_body', 'Plugin upload body is required');
  assertContentLengthWithin(c.req.raw, PLUGIN_UPLOAD_LIMIT_BYTES, 'plugin_too_large');
  const sandbox = await readyMinecraftSandbox(c.env, manifest, 'plugin-upload');
  await sandbox.mkdir('/workspace/server/plugins', { recursive: true });
  await sandbox.writeFile(
    `/workspace/server/plugins/${filename}`,
    limitBodyStream(c.req.raw.body, PLUGIN_UPLOAD_LIMIT_BYTES)
  );
  return c.json({ ok: true, filename });
});

app.get('/api/servers/:serverId/dynmap', requireAuth(), async (c) => {
  const manifest = await authorizedManifest(c.env, c.req.param('serverId'), c.get('user').userId);
  const includePreview = c.req.query('preview') === '1' || c.req.query('preview') === 'true';
  const previewHostname = configuredPreviewHostname(c.env);
  const previewDnsReady = c.env.PREVIEW_DNS_READY === 'true' && Boolean(previewHostname);
  let preview: { url: string } | null = null;
  let previewError: string | undefined;
  if (includePreview && previewHostname && c.env.PREVIEW_DNS_READY === 'true') {
    preview = await (await minecraftSandbox(c.env, manifest))
      .getDynmapPreview(previewHostname)
      .catch((error) => {
        previewError = error instanceof Error ? error.message : String(error);
        return null;
      });
  } else if (includePreview) {
    previewError = 'Sandbox preview DNS is not configured; using the mirrored map route.';
  }
  const r2Key = `dynmap/${manifest.serverId}/index.html`;
  const mirroredIndex = await c.env.DYNMAP_BUCKET.head(r2Key);
  const dynmapCompatibility = manifest.plugins.some(
    (plugin) => plugin.enabled && plugin.filename === 'dynmap.jar' && plugin.source.type !== 'builtin'
  )
    ? { compatible: true }
    : builtinDynmapCompatibility(manifest.preset, manifest.version);
  const enabled = manifest.dynmap.enabled && dynmapCompatibility.compatible;
  const tilesAvailable = enabled ? await hasDynmapWorldTiles(c.env, manifest.serverId) : false;
  return c.json({
    preview,
    previewError,
    previewDnsReady,
    r2Path: `/map/${manifest.serverId}/`,
    enabled,
    compatible: dynmapCompatibility.compatible,
    message: dynmapCompatibility.message,
    mirrored: enabled && Boolean(mirroredIndex),
    tilesAvailable,
    available: enabled && Boolean(mirroredIndex) && tilesAvailable,
    previewHostname: previewHostname ?? null,
    previewDnsRecord: previewHostname ? `*.${previewHostname}` : null
  });
});

app.post('/api/servers/:serverId/dynmap/render', requireAuth(), async (c) => {
  const server = await authorizedServer(c.env, c.req.param('serverId'), c.get('user').userId);
  return c.json(await server.startDynmapRender('user-dynmap-render'));
});

app.get('/map/:serverId', (c) => c.redirect(`/map/${c.req.param('serverId')}/`, 302));
app.get('/map/:serverId/*', async (c) => serveDynmap(c.env, c.req.param('serverId'), c.req.path));

app.put('/internal/dynmap/:serverId/*', async (c) => {
  const serverId = c.req.param('serverId');
  const prefix = `/internal/dynmap/${serverId}/`;
  const rel = decodeURIComponent(c.req.path.slice(prefix.length));
  await handleDynmapUpload(c.env, serverId, rel, c.req.raw);
  return c.json({ ok: true });
});

app.post('/api/connect/session', async (c) => {
  const body = await parseJson<ConnectorSessionRequest>(c.req.raw);
  return c.json(await handleConnectorSession(c.env, body, c.req.raw));
});

app.post('/api/connect/activity', async (c) => {
  const body = await parseJson<ConnectorActivityRequest>(c.req.raw);
  return c.json(await handleConnectorActivity(c.env, body));
});

app.post('/api/connect/progress', async (c) => {
  const body = await parseJson<ConnectorSessionRequest>(c.req.raw);
  return c.json(await handleConnectorProgress(c.env, body));
});

app.post('/api/connect/diagnostics', async (c) => {
  const body = await parseJson<ConnectorSessionRequest>(c.req.raw);
  return c.json(await handleConnectorDiagnostics(c.env, body));
});

app.post('/api/cli/auth/start', async (c) => {
  const body = await optionalJson<{ deviceName?: string }>(c.req.raw);
  return c.json(await startCliAuth(c.env, c.req.url, body?.deviceName));
});

app.post('/api/cli/auth/poll', async (c) => {
  const body = await parseJson<{ deviceToken: string }>(c.req.raw);
  return c.json(await pollCliAuth(c.env, c.req.url, body.deviceToken));
});

app.post('/api/cli/auth/approve', requireAuth(), async (c) => {
  const body = await parseJson<{ userCode: string }>(c.req.raw);
  return c.json(await approveCliAuth(c.env, body.userCode, c.get('user').userId));
});

app.get('/api/cli/me', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  return c.json({ user: auth.user, origin: new URL(c.req.url).origin });
});

app.post('/api/cli/logout', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  await c.env.USER_DO.getByName(auth.user.userId).revokeCliToken(auth.tokenHash);
  return c.json({ ok: true });
});

app.get('/api/cli/servers', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  return c.json({
    servers: await c.env.USER_DO.getByName(auth.user.userId).listServers()
  } satisfies CliServerListResponse);
});

app.post('/api/cli/connect-invite', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  const body = await parseJson<{ server?: string }>(c.req.raw);
  return c.json(await createConnectorInviteForCli(c.env, c.req.url, auth.user.userId, body.server));
});

app.post('/api/cli/servers/start', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  const body = await optionalJson<{ server?: string }>(c.req.raw);
  return c.json(await startServerForCli(c.env, auth.user.userId, body?.server));
});

app.post('/api/cli/servers/dynmap/render', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  const body = await optionalJson<{ server?: string }>(c.req.raw);
  return c.json(await startDynmapRenderForCli(c.env, auth.user.userId, body?.server));
});

app.post('/api/cli/servers/invite', async (c) => {
  const auth = await authenticateCliRequest(c.env, c.req.raw);
  const body = await parseJson<{ server?: string; prefix?: string; rotate?: boolean }>(c.req.raw);
  return c.json(await updateInviteForCli(c.env, c.req.url, auth.user.userId, body));
});

app.get('/api/connect/bridge/:serverId', async (c) =>
  handleConnectorBridge(c.env, c.req.param('serverId'), c.req.raw)
);

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const sandboxProxy = await proxyToSandbox(request, {
      Sandbox: env.MINECRAFT_SANDBOX as unknown as DurableObjectNamespace<Sandbox>
    });
    if (sandboxProxy) return sandboxProxy;
    return app.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<AppEnv>;

async function authorizedServer(env: AppEnv, serverId: string, userId: string) {
  const server = await minecraftSandboxById(env, serverId);
  const ownerId = await server.getOwnerId();
  if (!ownerId || ownerId !== userId) {
    throw new HttpError(404, 'server_not_found', 'Server not found');
  }
  return server;
}

async function authorizedManifest(
  env: AppEnv,
  serverId: string,
  userId: string
): Promise<MinecraftServerManifest> {
  const server = await authorizedServer(env, serverId, userId);
  const manifest = await server.getManifest();
  if (!manifest) throw new HttpError(404, 'server_not_found', 'Server not found');
  return manifest;
}

async function startCliAuth(
  env: AppEnv,
  requestUrl: string,
  deviceName?: string
): Promise<CliAuthStartResponse> {
  const registry = env.IDENTITY_REGISTRY.getByName('primary');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const deviceToken = randomBase64Url(32);
    const userCode = createCliUserCode();
    const expiresAt = new Date(Date.now() + CLI_DEVICE_AUTH_TTL_SECONDS * 1000).toISOString();
    const created = await registry.createCliAuthRequest({
      deviceHash: await sha256Hex(deviceToken),
      userCode,
      deviceName: cleanCliDeviceName(deviceName),
      expiresAt
    });
    if (!created.ok) continue;

    const origin = new URL(requestUrl).origin;
    return {
      deviceToken,
      userCode,
      verificationUrl: `${origin}/cli/auth?code=${encodeURIComponent(userCode)}`,
      expiresAt,
      intervalSeconds: CLI_DEVICE_AUTH_INTERVAL_SECONDS
    };
  }
  throw new HttpError(500, 'cli_auth_unavailable', 'Could not allocate a CLI auth code');
}

async function pollCliAuth(
  env: AppEnv,
  requestUrl: string,
  deviceToken: string
): Promise<CliAuthPollResponse> {
  if (!deviceToken || deviceToken.length > 256) {
    throw new HttpError(400, 'invalid_device_token', 'Device token is required');
  }

  const registry = env.IDENTITY_REGISTRY.getByName('primary');
  const status = await registry.consumeCliAuthRequest({
    deviceHash: await sha256Hex(deviceToken),
    now: new Date().toISOString()
  });

  if (status.status === 'pending') {
    return {
      status: 'pending',
      expiresAt: status.expiresAt,
      intervalSeconds: CLI_DEVICE_AUTH_INTERVAL_SECONDS
    };
  }
  if (status.status === 'approved') {
    return issueCliToken(env, requestUrl, status.userId, status.deviceName);
  }
  if (status.status === 'expired') {
    return { status: 'expired', message: 'The CLI auth code expired. Run cubeflare auth again.' };
  }
  if (status.status === 'consumed') {
    return { status: 'expired', message: 'The CLI auth code was already used. Run cubeflare auth again.' };
  }
  return { status: 'expired', message: 'The CLI auth code was not found. Run cubeflare auth again.' };
}

async function approveCliAuth(env: AppEnv, userCode: string, userId: string) {
  const code = normalizeCliUserCode(userCode);
  if (!code) throw new HttpError(400, 'invalid_cli_auth_code', 'CLI auth code is required');
  const status = await env.IDENTITY_REGISTRY.getByName('primary').approveCliAuthRequest({
    userCode: code,
    userId,
    now: new Date().toISOString()
  });
  if (status.status === 'missing') {
    throw new HttpError(404, 'cli_auth_not_found', 'CLI auth code was not found');
  }
  if (status.status === 'expired') {
    throw new HttpError(410, 'cli_auth_expired', 'CLI auth code has expired');
  }
  if (status.status === 'consumed') {
    throw new HttpError(409, 'cli_auth_consumed', 'CLI auth code has already been used');
  }
  return { ok: true, status: status.status };
}

async function issueCliToken(
  env: AppEnv,
  requestUrl: string,
  userId: string,
  deviceName: string
): Promise<Extract<CliAuthPollResponse, { status: 'approved' }>> {
  const secret = await cliTokenSecret(env);
  const userStub = env.USER_DO.getByName(userId);
  const profile = await userStub.getProfile();
  if (!profile) throw new HttpError(404, 'user_not_found', 'User not found');

  const signed = await createCliToken(secret, {
    userId,
    ttlSeconds: CLI_AUTH_TOKEN_TTL_SECONDS
  });
  await userStub.createCliToken({
    idHash: await sha256Hex(signed.token),
    label: cleanCliDeviceName(deviceName),
    expiresAt: signed.expiresAt
  });

  return {
    status: 'approved',
    token: signed.token,
    expiresAt: signed.expiresAt,
    origin: new URL(requestUrl).origin,
    user: {
      userId: profile.id,
      email: profile.email,
      displayName: profile.displayName
    }
  };
}

async function authenticateCliRequest(env: AppEnv, request: Request) {
  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!token) throw new HttpError(401, 'cli_not_authenticated', 'Run cubeflare auth first');

  const secret = await cliTokenSecret(env);
  const payload = await verifyCliToken(secret, token).catch((error) => {
    throw new HttpError(401, 'invalid_cli_token', errorMessage(error));
  });
  const tokenHash = await sha256Hex(token);
  const user = await env.USER_DO.getByName(payload.userId).validateCliToken({
    idHash: tokenHash,
    now: new Date().toISOString()
  });
  if (!user) throw new HttpError(401, 'invalid_cli_token', 'CLI token is expired or revoked');
  return { user, tokenHash };
}

async function createConnectorInviteForCli(
  env: AppEnv,
  requestUrl: string,
  userId: string,
  serverRef?: string
): Promise<ConnectorInviteResponse> {
  const servers = await env.USER_DO.getByName(userId).listServers();
  const summary = resolveCliServer(servers, serverRef);
  const manifest = await authorizedManifest(env, summary.id, userId);
  return createConnectorInviteForUser(env, requestUrl, manifest, userId);
}

async function createConnectorInviteForUser(
  env: AppEnv,
  requestUrl: string,
  manifest: MinecraftServerManifest,
  userId: string
): Promise<ConnectorInviteResponse> {
  const host = publicJoinHost(env, manifest);
  const inviteCode = await registerPersistentConnectorInvite(env, manifest, userId);

  const origin = new URL(requestUrl).origin;
  return {
    serverId: manifest.serverId,
    host,
    inviteCode,
    expiresAt: null,
    localAddress: LOCAL_CONNECT_ADDRESS,
    installCommand: buildInstallCommand(origin),
    command: buildConnectorCommand(inviteCode)
  };
}

async function registerPersistentConnectorInvite(
  env: AppEnv,
  manifest: MinecraftServerManifest,
  ownerId = manifest.ownerId
): Promise<string> {
  const secret = await connectorInviteSecret(env);
  const inviteCode = await createPersistentInviteCode(secret, manifest);
  const registered = await env.IDENTITY_REGISTRY.getByName('primary').upsertServerInvite({
    codeHash: await connectorInviteCodeHash(secret, inviteCode),
    serverId: manifest.serverId,
    ownerId,
    host: publicJoinHost(env, manifest),
    kind: 'primary',
    expiresAt: null
  });
  if (!registered.ok) {
    throw new HttpError(500, 'connector_invite_unavailable', 'Could not register the server invite code');
  }
  return inviteCode;
}

async function startServerForCli(env: AppEnv, userId: string, serverRef?: string) {
  const servers = await env.USER_DO.getByName(userId).listServers();
  const summary = resolveCliServer(servers, serverRef);
  const server = await authorizedServer(env, summary.id, userId);
  return server.startServer('cli-start');
}

async function startDynmapRenderForCli(env: AppEnv, userId: string, serverRef?: string) {
  const servers = await env.USER_DO.getByName(userId).listServers();
  const summary = resolveCliServer(servers, serverRef);
  const server = await authorizedServer(env, summary.id, userId);
  return server.startDynmapRender('cli-dynmap-render');
}

async function updateInviteForCli(
  env: AppEnv,
  requestUrl: string,
  userId: string,
  input: { server?: string; prefix?: string; rotate?: boolean }
): Promise<ConnectorInviteResponse> {
  const servers = await env.USER_DO.getByName(userId).listServers();
  const summary = resolveCliServer(servers, input.server);
  const server = await authorizedServer(env, summary.id, userId);
  await server.patch({
    invite: {
      prefix: input.prefix,
      rotate: input.rotate
    }
  });
  const manifest = await server.getManifest();
  if (!manifest) throw new HttpError(404, 'server_not_found', 'Server not found');
  await registerPersistentConnectorInvite(env, manifest);
  return createConnectorInviteForUser(env, requestUrl, manifest, userId);
}

function resolveCliServer(servers: ServerSummary[], serverRef?: string): ServerSummary {
  if (!servers.length) {
    throw new HttpError(404, 'no_servers', 'No Minecraft servers exist for this account');
  }
  const query = normalizeServerLookup(serverRef ?? '');
  if (!query) {
    if (servers.length === 1) return servers[0];
    throw new HttpError(
      400,
      'server_required',
      'Choose a server name',
      servers.map((server) => ({ id: server.id, name: server.name, status: server.status }))
    );
  }

  const exact = servers.filter((server) =>
    [
      server.id,
      server.name,
      server.joinHost,
      server.joinHost.split('.')[0] ?? ''
    ].some((value) => normalizeServerLookup(value) === query)
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new HttpError(409, 'server_ambiguous', 'Server name is ambiguous', exact);
  }

  const prefix = servers.filter((server) =>
    [server.id, server.name, server.joinHost].some((value) => normalizeServerLookup(value).startsWith(query))
  );
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new HttpError(409, 'server_ambiguous', 'Server name is ambiguous', prefix);
  }

  throw new HttpError(
    404,
    'server_not_found',
    `No server matched "${serverRef}"`,
    servers.map((server) => ({ id: server.id, name: server.name, status: server.status }))
  );
}

function normalizeServerLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function minecraftSandbox(env: AppEnv, manifest: MinecraftServerManifest) {
  return minecraftSandboxById(env, manifest.serverId);
}

async function minecraftSandboxById(
  env: AppEnv,
  serverId: string,
  locationPreference?: MinecraftLocationPreference
) {
  const options = minecraftSandboxOptions(env);
  const effectiveId = serverId.toLowerCase();
  const locationHint = durableObjectLocationHint(
    cleanMinecraftLocationPreference(locationPreference)
  );
  const id = env.MINECRAFT_SANDBOX.idFromName(effectiveId);
  const directStub = (
    locationHint
      ? env.MINECRAFT_SANDBOX.get(id, { locationHint })
      : env.MINECRAFT_SANDBOX.get(id)
  ) as unknown as MinecraftSandbox;
  await directStub.configure({
    sandboxName: { name: effectiveId, normalizeId: true },
    ...options
  });

  return getSandbox(env.MINECRAFT_SANDBOX, effectiveId, {
    normalizeId: true,
    ...options
  });
}

function minecraftSandboxOptions(env: AppEnv) {
  return {
    sleepAfter: env.MC_SLEEP_AFTER ?? '30m',
    transport: env.SANDBOX_TRANSPORT ?? 'rpc',
    containerTimeouts: {
      instanceGetTimeoutMS: 60_000,
      portReadyTimeoutMS: 240_000,
      waitIntervalMS: 500
    }
  } as const;
}

async function recordRequestLocation(
  request: Request,
  server: MinecraftSandbox
): Promise<void> {
  const location = requestLocationObservation(request);
  if (!location) return;
  await server.recordLocationObservation(location).catch(() => undefined);
}

function requestLocationObservation(request: Request): RuntimeLocationObservation | undefined {
  const cf = request.cf;
  const colo = typeof cf?.colo === 'string' ? cf.colo : undefined;
  const region = typeof cf?.region === 'string' ? cf.region : undefined;
  const country = typeof cf?.country === 'string' ? cf.country : undefined;
  if (!colo && !region && !country) return undefined;
  return {
    colo,
    region,
    country,
    source: 'worker-request',
    observedAt: new Date().toISOString()
  };
}

function buildConnectorCommand(inviteCode: string): string {
  return ['cubeflare', 'connect', shellArg(inviteCode)].join(' ');
}

function buildInstallCommand(origin: string): string {
  return `curl -fsSL ${shellArg(`${origin}/install.sh`)} | sh`;
}

async function createPersistentInviteCode(
  secret: string,
  manifest: MinecraftServerManifest
): Promise<string> {
  const invite = normalizeInviteConfig(manifest);
  const digest = await hmacSha256Hex(
    secret,
    ['connector-invite', manifest.serverId, manifest.ownerId, invite.prefix, invite.rotation].join(':')
  );
  const suffix = inviteSuffixFromHexDigest(digest);
  return formatConnectorInviteCode(invite.prefix, suffix);
}

function normalizeConnectorInviteCode(value: string): string | null {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const parts = normalized.split('-');
  if (parts.length < 2 + CONNECTOR_INVITE_SUFFIX_GROUPS || parts[0] !== 'CF') return null;
  const suffixGroups = parts.slice(-CONNECTOR_INVITE_SUFFIX_GROUPS);
  const prefixGroups = parts.slice(1, -CONNECTOR_INVITE_SUFFIX_GROUPS);
  const prefix = prefixGroups.join('-');
  const suffix = suffixGroups.join('');
  if (prefix.length < 3 || prefix.length > 40) return null;
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(prefix)) return null;
  if (suffix.length !== CONNECTOR_INVITE_SUFFIX_LENGTH) return null;
  if (!new RegExp(`^[${CONNECTOR_INVITE_ALPHABET}]+$`).test(suffix)) return null;
  return formatConnectorInviteCode(prefix, suffix);
}

function formatConnectorInviteCode(prefix: string, suffix: string): string {
  const groups = [];
  for (let index = 0; index < suffix.length; index += 4) {
    groups.push(suffix.slice(index, index + 4));
  }
  return `CF-${prefix}-${groups.join('-')}`;
}

function inviteSuffixFromHexDigest(hex: string): string {
  let suffix = '';
  for (let index = 0; index < CONNECTOR_INVITE_SUFFIX_LENGTH; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    suffix += CONNECTOR_INVITE_ALPHABET[byte & 31];
  }
  return suffix;
}

async function connectorInviteCodeHash(secret: string, code: string): Promise<string> {
  const normalized = normalizeConnectorInviteCode(code);
  if (!normalized) throw new HttpError(400, 'invalid_connector_invite', 'Invite code is invalid');
  return hmacSha256Hex(secret, normalized);
}

function shellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createCliUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes]
    .map((byte) => alphabet[byte % alphabet.length])
    .join('')
    .replace(/^(.{4})(.{4})$/, '$1-$2');
}

function normalizeCliUserCode(value: string): string {
  const cleaned = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 8) return '';
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

function cleanCliDeviceName(value: string | undefined): string {
  return (value ?? 'Cubeflare CLI').trim().replace(/\s+/g, ' ').slice(0, 120) || 'Cubeflare CLI';
}

async function readyMinecraftSandbox(
  env: AppEnv,
  manifest: MinecraftServerManifest,
  reason: string
) {
  const sandbox = await minecraftSandbox(env, manifest);
  await sandbox.startServer(reason);
  return sandbox;
}

async function lifecycleHttpError(
  env: AppEnv,
  server: MinecraftSandbox,
  code: string,
  title: string,
  error: unknown
): Promise<HttpError> {
  const manifest = await server.getManifest();
  const message = errorMessage(error);
  const diagnostics = {
    message,
    events: await server.recentEvents(12),
    logs: manifest ? await processLogSnapshot(env, manifest) : undefined
  };
  return new HttpError(502, code, `${title}: ${message}`, diagnostics);
}

async function processLogSnapshot(env: AppEnv, manifest: MinecraftServerManifest) {
  const sandbox = await minecraftSandbox(env, manifest);
  const processes = await Promise.all(
    ['minecraft-server', 'minecraft-bridge', 'dynmap-sync'].map(async (processId) => {
      const process = await sandbox.getProcess(processId).catch(() => null);
      return {
        processId,
        status: process?.status ?? null,
        exitCode: process?.exitCode ?? null,
        stdoutTail: '',
        stderrTail: process ? '' : 'Process not found'
      };
    })
  );
  const logs = processes[0] ?? { processId: 'minecraft-server', stdoutTail: '', stderrTail: '' };
  return {
    processId: logs.processId,
    stdoutTail: logs.stdoutTail,
    stderrTail: logs.stderrTail,
    processes
  };
}

function tailLines(value: string, maxLines = 80): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultVersionFor(versions: Array<{ version: string; channel: string }> | undefined): string {
  return (
    versions?.find((version) => version.channel === 'latest release')?.version ??
    versions?.find((version) => version.channel === 'latest')?.version ??
    versions?.[0]?.version ??
    DEFAULT_MINECRAFT_VERSION
  );
}

async function serveTextAsset(
  c: Context<HonoBindings>,
  path: string,
  contentType: string,
  rewrite: (source: string, origin: string) => string
): Promise<Response> {
  const assetResponse = await c.env.ASSETS.fetch(new Request(new URL(path, c.req.url)));
  if (!assetResponse.ok) return assetResponse;
  const origin = new URL(c.req.url).origin;
  return new Response(rewrite(await assetResponse.text(), origin), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    }
  });
}

function rewriteInstallScript(source: string, origin: string): string {
  return source.replace(
    /BASE_URL="\$\{CUBEFLARE_INSTALL_BASE_URL:-[^}]*}"/,
    () => `BASE_URL="\${CUBEFLARE_INSTALL_BASE_URL:-${origin}}"`
  );
}

function rewriteCliDownload(source: string, origin: string): string {
  return source.replace(
    /const DEFAULT_ORIGIN = process\.env\.CUBEFLARE_DEFAULT_ORIGIN \|\| '[^']*';/,
    () => `const DEFAULT_ORIGIN = process.env.CUBEFLARE_DEFAULT_ORIGIN || '${origin}';`
  );
}

async function optionalJson<T>(request: Request): Promise<T | null> {
  if (!request.headers.get('Content-Type')?.includes('application/json')) return null;
  return parseJson<T>(request);
}

function createMinecraftLogStream(sandbox: MinecraftSandbox): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const snapshot = await sandbox.getProcessLogs('minecraft-server').catch(() => ({
          stdout: '',
          stderr: 'Minecraft process has not started yet.',
          processId: 'minecraft-server',
          timestamp: new Date().toISOString()
        }));
        enqueueSse(controller, encoder, 'snapshot', snapshot);

        const live = await sandbox.streamProcessLogs('minecraft-server').catch((error: unknown) => {
          enqueueSse(controller, encoder, 'notice', {
            type: 'stream_unavailable',
            data: error instanceof Error ? error.message : String(error),
            processId: 'minecraft-server',
            timestamp: new Date().toISOString()
          });
          return null;
        });
        if (!live) {
          controller.close();
          return;
        }

        reader = live.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        enqueueSse(controller, encoder, 'notice', {
          type: 'stream_error',
          data: error instanceof Error ? error.message : String(error),
          processId: 'minecraft-server',
          timestamp: new Date().toISOString()
        });
        controller.close();
      }
    },
    cancel() {
      reader?.cancel().catch(() => undefined);
    }
  });
}

function enqueueSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  payload: unknown
) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
}

function isSessionAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code) === 'SESSION_ALREADY_EXISTS') ||
    message.includes('already exists')
  );
}

function parseTerminalDimension(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function cleanActiveConnectionCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.trunc(parsed), 10_000);
}

function assertContentLengthWithin(request: Request, maxBytes: number, code: string): void {
  const contentLength = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, code, `Upload must be at most ${formatByteLimit(maxBytes)}`);
  }
}

function limitBodyStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new HttpError(413, 'upload_too_large', `Upload must be at most ${formatByteLimit(maxBytes)}`);
        }
        controller.enqueue(chunk);
      }
    })
  );
}

function formatByteLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : `${bytes} bytes`;
}

function safeServerPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') return '/workspace/server';
  const normalized = trimmed.startsWith('/') ? trimmed : `/workspace/server/${trimmed}`;
  if (!normalized.startsWith('/workspace/server/') && normalized !== '/workspace/server') {
    throw new HttpError(400, 'invalid_path', 'Path must stay inside /workspace/server');
  }
  if (normalized.includes('..')) {
    throw new HttpError(400, 'invalid_path', 'Path traversal is not allowed');
  }
  if (isInternalServerPath(normalized)) {
    throw new HttpError(403, 'protected_path', 'This path is managed by Cubeflare');
  }
  return normalized;
}

function isInternalServerPath(path: string): boolean {
  const normalized = path.startsWith('/') ? path : `/workspace/server/${path}`;
  return normalized === '/workspace/server/.cubeflare' || normalized.startsWith('/workspace/server/.cubeflare/');
}

function cleanGenericFilename(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._ -]/g, '').trim().slice(0, 160);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new HttpError(400, 'invalid_filename', 'Filename is invalid');
  }
  return cleaned;
}

function cleanPluginFilename(value: string): string {
  const cleaned = cleanGenericFilename(value);
  if (!cleaned.endsWith('.jar')) {
    throw new HttpError(400, 'invalid_plugin', 'Plugin filename must end in .jar');
  }
  return cleaned;
}

async function serveDynmap(env: AppEnv, serverId: string, path: string): Promise<Response> {
  const keySuffix = dynmapPathSuffix(serverId, path);
  const key = `dynmap/${serverId}/${keySuffix || 'index.html'}`;
  const object = await env.DYNMAP_BUCKET.get(key);
  if (!object) {
    if (keySuffix === 'standalone/config.js') {
      return dynmapSecurityHeaders(dynmapStandaloneConfigResponse());
    }
    return dynmapSecurityHeaders(new Response('Not found', { status: 404 }));
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', key.endsWith('.html') ? 'no-store' : 'public, max-age=60');
  return dynmapSecurityHeaders(new Response(object.body, { headers }));
}

async function hasDynmapWorldTiles(env: AppEnv, serverId: string): Promise<boolean> {
  const worlds = await dynmapWorldNames(env, serverId);
  for (const world of worlds) {
    const listed = await env.DYNMAP_BUCKET.list({
      prefix: `dynmap/${serverId}/tiles/${world}/`,
      limit: 1
    });
    if (listed.objects.length > 0) return true;
  }
  return false;
}

async function dynmapWorldNames(env: AppEnv, serverId: string): Promise<string[]> {
  const fallback = ['world'];
  const configuration = await env.DYNMAP_BUCKET.get(`dynmap/${serverId}/up/configuration`).catch(() => null);
  if (!configuration) return fallback;
  const parsed = await configuration.json<{ worlds?: Array<{ name?: unknown }> }>().catch(() => null);
  const worlds = parsed?.worlds
    ?.map((world) => cleanDynmapWorldName(world.name))
    .filter((name): name is string => Boolean(name));
  return worlds?.length ? [...new Set(worlds)] : fallback;
}

function cleanDynmapWorldName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) return null;
  return name;
}

function dynmapPathSuffix(serverId: string, path: string): string {
  const prefix = `/map/${serverId}/`;
  const rawSuffix = path === `/map/${serverId}` ? '' : path.startsWith(prefix) ? path.slice(prefix.length) : '';
  const suffix = rawSuffix ? decodeDynmapPath(rawSuffix) : 'index.html';
  if (suffix.startsWith('/') || suffix.split('/').some((part) => part === '..')) {
    throw new HttpError(400, 'invalid_dynmap_path', 'Dynmap path is invalid');
  }
  const worldUpdate = /^up\/world\/([^/]+)\/[^/]+$/.exec(suffix);
  if (worldUpdate) {
    return `up/world/${worldUpdate[1]}/latest.json`;
  }
  return suffix;
}

function decodeDynmapPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function dynmapStandaloneConfigResponse(): Response {
  const body = [
    'var config = {',
    ' url : {',
    "  configuration: 'up/configuration',",
    "  update: 'up/world/{world}/{timestamp}',",
    "  sendmessage: 'up/sendmessage',",
    "  login: 'up/login',",
    "  register: 'up/register',",
    "  tiles: 'tiles/',",
    "  markers: 'tiles/'",
    ' }',
    '};',
    ''
  ].join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleDynmapUpload(
  env: AppEnv,
  serverId: string,
  rel: string,
  request: Request
): Promise<void> {
  const secret = await dynmapSyncSecret(env);
  if (!request.body) throw new HttpError(400, 'missing_body', 'Upload body is required');
  if (!rel || rel.includes('..') || rel.startsWith('/')) {
    throw new HttpError(400, 'invalid_path', 'Dynmap path is invalid');
  }
  const timestamp = Number.parseInt(request.headers.get('x-cubeflare-timestamp') ?? '', 10);
  const signature = request.headers.get('x-cubeflare-signature') ?? '';
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 60_000) {
    throw new HttpError(401, 'stale_dynmap_upload', 'Dynmap upload timestamp is stale');
  }
  const expected = await hmacSha256Hex(secret, `${serverId}.${rel}.${timestamp}`);
  if (!timingSafeEqual(expected, signature)) {
    throw new HttpError(401, 'bad_dynmap_signature', 'Dynmap upload signature is invalid');
  }
  await env.DYNMAP_BUCKET.put(`dynmap/${serverId}/${rel}`, request.body, {
    httpMetadata: {
      contentType: request.headers.get('Content-Type') ?? 'application/octet-stream'
    }
  });
}

async function handleConnectorSession(
  env: AppEnv,
  body: ConnectorSessionRequest,
  request: Request
) {
  const inviteSecret = await connectorInviteSecret(env);
  const { server, manifest, host } = await authorizeConnectorRequest(env, body, inviteSecret, { touchInvite: true });
  await recordRequestLocation(request, server);

  try {
    await server.startServer('connector-session');
  } catch (error) {
    throw new HttpError(502, 'server_start_failed', `Server start failed: ${errorMessage(error)}`);
  }

  const bridge = await createBridgeToken(await minecraftBridgeSecret(env), {
    serverId: manifest.serverId,
    ttlSeconds: BRIDGE_TOKEN_TTL_SECONDS
  });
  const connectorSessionId = randomBase64Url(16);
  const activity = await createConnectorActivityToken(await connectorActivitySecret(env), {
    serverId: manifest.serverId,
    host,
    sessionId: connectorSessionId,
    ttlSeconds: CONNECTOR_ACTIVITY_TOKEN_TTL_SECONDS
  });
  const publicBaseHost = publicBaseHostForRequest(env, request);
  const endpoint = await server.getBridgeEndpoint(publicBaseHost, bridge.token, publicBaseHost);
  return {
    serverId: manifest.serverId,
    host,
    bridgeUrl: endpoint.url,
    bridgeToken: endpoint.token,
    activityToken: activity.token,
    activityExpiresAt: activity.expiresAt,
    expiresAt: bridge.expiresAt,
    expiresInSeconds: BRIDGE_TOKEN_TTL_SECONDS,
    localAddress: LOCAL_CONNECT_ADDRESS,
    requestId: randomBase64Url(12)
  };
}

async function handleConnectorActivity(env: AppEnv, body: ConnectorActivityRequest) {
  const secret = await connectorActivitySecret(env);
  if (!body.token || body.token.length > 4096) {
    throw new HttpError(400, 'invalid_activity_token', 'Activity token is required');
  }

  const payload = await verifyConnectorActivityToken(secret, body.token).catch((error) => {
    throw new HttpError(401, 'invalid_activity_token', errorMessage(error));
  });
  const server = await minecraftSandboxById(env, payload.serverId);
  const manifest = await server.getManifest();
  if (!manifest) throw new HttpError(404, 'server_not_found', 'Server not found');

  const host = publicJoinHost(env, manifest);
  if (payload.host.toLowerCase() !== host.toLowerCase()) {
    throw new HttpError(401, 'invalid_activity_token', 'Activity token is for a different server host');
  }

  const activeBridgeConnections = cleanActiveConnectionCount(body.activeConnections);
  const summary = await server.recordConnectorActivity({
    sessionId: payload.sessionId,
    activeBridgeConnections
  });
  return {
    ok: true,
    serverId: manifest.serverId,
    activeConnections: activeBridgeConnections,
    summary
  };
}

async function handleConnectorProgress(
  env: AppEnv,
  body: ConnectorSessionRequest
): Promise<ConnectorProgressResponse> {
  const secret = await connectorInviteSecret(env);
  const { server, manifest, host } = await authorizeConnectorRequest(env, body, secret);
  return {
    serverId: manifest.serverId,
    host,
    summary: await server.getSummary(),
    runtime: await server.runtimeSnapshot().catch(() => null),
    lifecycle: await server.getLifecyclePhase(),
    events: await server.recentEvents(8)
  };
}

async function handleConnectorDiagnostics(
  env: AppEnv,
  body: ConnectorSessionRequest
): Promise<ConnectorDiagnosticsResponse> {
  const secret = await connectorInviteSecret(env);
  const { server, manifest, host } = await authorizeConnectorRequest(env, body, secret);
  const runtime = await server.runtimeSnapshot().catch(() => null);
  return {
    serverId: manifest.serverId,
    host,
    summary: await server.getSummary(),
    runtime,
    lifecycle: await server.getLifecyclePhase(),
    events: await server.recentEvents(16)
  };
}

async function authorizeConnectorRequest(
  env: AppEnv,
  body: ConnectorSessionRequest,
  secret: string,
  options: { touchInvite?: boolean } = {}
) {
  if (!body.inviteCode || body.inviteCode.length > 128) {
    throw new HttpError(400, 'invalid_invite_code', 'Invite code is required');
  }

  const inviteCode = normalizeConnectorInviteCode(body.inviteCode);
  if (!inviteCode) {
    throw new HttpError(401, 'invalid_invite_code', 'Invite code is invalid');
  }

  const invite = await env.IDENTITY_REGISTRY.getByName('primary').resolveServerInvite({
    codeHash: await connectorInviteCodeHash(secret, inviteCode),
    now: new Date().toISOString(),
    touch: options.touchInvite
  });
  if (!invite) {
    throw new HttpError(401, 'invalid_invite_code', 'Invite code is invalid');
  }
  if (invite.kind !== 'primary') {
    throw new HttpError(401, 'invalid_invite_code', 'Invite code is not a server invite');
  }
  const server = await minecraftSandboxById(env, invite.serverId);
  const manifest = await server.getManifest();
  if (!manifest || manifest.ownerId !== invite.ownerId) {
    throw new HttpError(404, 'server_not_found', 'Server not found');
  }
  const host = publicJoinHost(env, manifest);
  if (invite.host.toLowerCase() !== host.toLowerCase()) {
    throw new HttpError(401, 'invalid_invite_code', 'Invite code is for a different server host');
  }
  if (body.server && !connectorServerMatches(body.server, manifest, host)) {
    throw new HttpError(400, 'server_mismatch', 'Invite code does not match the requested server');
  }
  return { server, manifest, host };
}

function connectorServerMatches(value: string, manifest: MinecraftServerManifest, host: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  return normalized === host.toLowerCase() || normalized === manifest.serverId.toLowerCase();
}

async function handleConnectorBridge(env: AppEnv, serverId: string, request: Request): Promise<Response> {
  if (!/^[a-z0-9-]{1,63}$/.test(serverId)) {
    return problem(404, 'server_not_found', 'Server not found');
  }

  const secret = await minecraftBridgeSecret(env);
  const bridgeToken = request.headers.get('x-cubeflare-bridge-token') ?? '';
  const payload = await verifyBridgeToken(secret, bridgeToken).catch(() => null);
  if (!payload || payload.serverId !== serverId) {
    return problem(401, 'invalid_bridge_token', 'Bridge token is invalid');
  }

  const server = await minecraftSandboxById(env, serverId);
  if (!(await server.getManifest())) {
    return problem(404, 'server_not_found', 'Server not found');
  }

  const headers = new Headers(request.headers);
  headers.delete(PREVIEW_PROXY_HEADER);
  headers.delete(PREVIEW_PROXY_PORT_HEADER);
  headers.delete(PREVIEW_PROXY_TOKEN_HEADER);
  headers.delete(PREVIEW_PROXY_SANDBOX_ID_HEADER);
  headers.set(PREVIEW_PROXY_HEADER, '1');
  headers.set(PREVIEW_PROXY_PORT_HEADER, String(MINECRAFT_BRIDGE_PORT));
  headers.set(PREVIEW_PROXY_TOKEN_HEADER, BRIDGE_PREVIEW_TOKEN);
  headers.set(PREVIEW_PROXY_SANDBOX_ID_HEADER, serverId);
  headers.set('X-Sandbox-Name', serverId);

  const proxyRequest = new Request(request, {
    headers,
    redirect: 'manual'
  });
  return (await minecraftSandboxById(env, serverId)).fetch(proxyRequest);
}
