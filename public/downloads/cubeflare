#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = process.env.CUBEFLARE_DEFAULT_ORIGIN || 'https://minecraft.ashishkumarsingh.com';
const CONFIG_DIR = process.env.CUBEFLARE_HOME || path.join(os.homedir(), '.cubeflare');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_BUFFERED_BYTES = 1024 * 1024;
const AUTO_PORT_BASE = 25565;
const AUTO_PORT_SPAN = 20000;
const CONNECTOR_INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CONNECTOR_INVITE_SUFFIX_LENGTH = 16;
const CONNECTOR_INVITE_SUFFIX_GROUPS = 4;

const colorEnabled = !process.env.NO_COLOR && process.stdout.isTTY;
const color = {
  bold: ansi(1, 22),
  dim: ansi(2, 22),
  cyan: ansi(36, 39),
  green: ansi(32, 39),
  yellow: ansi(33, 39),
  red: ansi(31, 39),
  gray: ansi(90, 39)
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(color.red(`Error: ${errorMessage(error)}`));
    process.exit(error instanceof CliError ? error.exitCode : 1);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = normalizeCommand(argv.shift());
  const commandArgv = argv;

  if (!command || command === 'help') {
    printUsage();
    return;
  }

  if (command === 'auth' || command === 'login') {
    await commandAuth(commandArgv);
    return;
  }
  if (command === 'connect' || command === 'join') {
    await commandConnect(commandArgv);
    return;
  }
  if (command === 'servers' || command === 'ls') {
    await commandServers(commandArgv);
    return;
  }
  if (command === 'whoami' || command === 'me') {
    await commandWhoami(commandArgv);
    return;
  }
  if (command === 'logout') {
    await commandLogout(commandArgv);
    return;
  }

  throw new CliError(`Unknown command "${command}". Run cubeflare --help.`);
}

async function commandAuth(argv) {
  const args = parseOptions(argv, {
    origin: 'value',
    'device-name': 'value',
    'no-browser': 'boolean',
    help: 'boolean',
    h: 'boolean'
  });
  if (args.help || args.h) {
    printAuthUsage();
    return;
  }

  const origin = normalizeOrigin(args.origin || DEFAULT_ORIGIN);
  const deviceName = args['device-name'] || `${os.hostname()} terminal`;
  printTitle('Cubeflare Auth');

  const start = await apiJson(origin, '/api/cli/auth/start', {
    method: 'POST',
    body: { deviceName }
  });

  console.log(`${color.dim('Origin')}  ${origin}`);
  console.log(`${color.dim('Code')}    ${color.bold(color.cyan(start.userCode))}`);
  console.log(`${color.dim('Open')}    ${start.verificationUrl}`);
  console.log('');

  if (!args['no-browser']) {
    const opened = openBrowser(start.verificationUrl);
    console.log(opened ? color.gray('Opened the browser for approval.') : color.gray('Could not open a browser automatically.'));
  }
  console.log(color.gray('Approve the code in the browser. Waiting for confirmation...'));

  const spinner = createSpinner('Waiting for browser approval');
  spinner.start();
  const expiresAt = Date.parse(start.expiresAt);
  const intervalMs = Math.max(1000, Number(start.intervalSeconds || 2) * 1000);

  while (Date.now() < expiresAt) {
    await delay(intervalMs);
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    spinner.update(`Waiting for browser approval (${remaining}s left)`);
    const poll = await apiJson(origin, '/api/cli/auth/poll', {
      method: 'POST',
      body: { deviceToken: start.deviceToken }
    });
    if (poll.status === 'pending') continue;
    if (poll.status === 'approved') {
      await saveConfig({
        version: 1,
        origin: poll.origin || origin,
        token: poll.token,
        expiresAt: poll.expiresAt,
        user: poll.user,
        updatedAt: new Date().toISOString()
      });
      spinner.succeed('Authenticated');
      console.log('');
      console.log(`${color.dim('Account')} ${poll.user.email}`);
      console.log(`${color.dim('Config')}  ${CONFIG_FILE}`);
      console.log('');
      console.log(color.bold('Next commands'));
      console.log(`  cubeflare servers`);
      console.log(`  cubeflare connect <server name>`);
      return;
    }
    spinner.fail('Authentication did not complete');
    throw new CliError(poll.message || 'CLI auth expired');
  }

  spinner.fail('Authentication expired');
  throw new CliError('The approval code expired. Run cubeflare auth again.');
}

async function commandConnect(argv) {
  const args = parseOptions(argv, {
    origin: 'value',
    server: 'value',
    code: 'value',
    host: 'value',
    port: 'value',
    help: 'boolean',
    h: 'boolean'
  });
  if (args.help || args.h) {
    printConnectUsage();
    return;
  }

  const positional = args._.join(' ').trim();
  const positionalIsInvite = isConnectorInviteCode(positional);
  const inviteMode = positionalIsInvite || Boolean(args.code);
  const config = inviteMode ? null : await requireConfig();
  const origin = normalizeOrigin(args.origin || config?.origin || DEFAULT_ORIGIN);
  const listenHost = String(args.host || process.env.CUBEFLARE_LISTEN_HOST || '127.0.0.1').trim();

  let inviteCode = String(args.code || (inviteMode ? positional : '')).trim();
  let serverHost = String(args.server || '').trim().toLowerCase();
  let serverLabel = serverHost || (positionalIsInvite ? normalizeConnectorInviteCode(positional) : 'Minecraft server');

  if (!inviteCode) {
    const serverRef = String(args.server || positional || '').trim();
    const response = await apiJson(origin, '/api/cli/connect-invite', {
      method: 'POST',
      token: config.token,
      body: { server: serverRef || undefined }
    });
    inviteCode = response.inviteCode;
    serverHost = response.host;
    serverLabel = response.host;
  }

  if (!inviteCode) {
    throw new CliError('Missing invite code. Run cubeflare auth, or run cubeflare connect <invite-code>.');
  }
  if (!serverHost && !isConnectorInviteCode(inviteCode)) {
    throw new CliError('Could not determine the Cubeflare server host.');
  }

  printTitle('Cubeflare Connect');
  console.log(`${color.dim('Server')} ${serverLabel}`);
  console.log(`${color.dim('Origin')} ${origin}`);
  console.log(`${color.dim('Access')} ${inviteMode ? 'Server invite code' : 'Signed-in CLI account'}`);
  console.log('');

  const session = await prepareBridgeSession({
    origin,
    inviteCode,
    server: serverHost
  });
  const activity = createActivityReporter({
    origin,
    token: session.activityToken
  });

  const explicitPort = args.port !== undefined;
  const requestedPort = explicitPort ? parsePort(args.port) : preferredServerPort(session.serverId || serverHost);
  const listenPort = explicitPort
    ? await requirePortAvailable(listenHost, requestedPort)
    : await findAvailablePort(listenHost, requestedPort);

  let warmSession = session;
  const openSession = async () => {
    if (warmSession && Date.parse(warmSession.expiresAt) - Date.now() > 15_000) {
      const current = warmSession;
      warmSession = null;
      activity.useSession(current);
      return current;
    }
    const next = await openBridgeSession({
      origin,
      inviteCode,
      server: serverHost
    });
    activity.useSession(next);
    return next;
  };

  const listener = net.createServer((client) => {
    const releaseActivity = activity.acquire();
    client.once('close', releaseActivity);
    handleClient(client, openSession).catch((error) => {
      console.error(color.red(`Bridge failed: ${errorMessage(error)}`));
      client.destroy();
    });
  });

  listener.on('error', (error) => {
    console.error(color.red(`Local listener failed: ${errorMessage(error)}`));
    process.exit(1);
  });

  await new Promise((resolve) => listener.listen(listenPort, listenHost, resolve));

  console.log('');
  printBox('Ready', [
    ['Minecraft address', `${listenHost}:${listenPort}`],
    ['Remote server', session.host || serverHost],
    ['Status', 'Keep this terminal open while players are connected']
  ]);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log(color.gray('Closing Cubeflare Connect...'));
    await activity.close().catch(() => undefined);
    await new Promise((resolve) => listener.close(resolve)).catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

async function commandServers(argv) {
  const args = parseOptions(argv, {
    origin: 'value',
    prefix: 'value',
    rotate: 'boolean',
    help: 'boolean',
    h: 'boolean'
  });
  if (args.help || args.h) {
    printServersUsage();
    return;
  }
  const config = await requireConfig();
  const origin = normalizeOrigin(args.origin || config.origin || DEFAULT_ORIGIN);
  const subcommand = String(args._[0] || '').toLowerCase();
  if (subcommand === 'start' || subcommand === 'wake') {
    const serverRef = args._.slice(1).join(' ').trim();
    printTitle('Cubeflare Server Start');
    const spinner = createSpinner(serverRef ? `Starting ${serverRef}` : 'Starting server');
    spinner.start();
    const response = await apiJson(origin, '/api/cli/servers/start', {
      method: 'POST',
      token: config.token,
      body: { server: serverRef || undefined }
    });
    spinner.succeed('Server is ready');
    printServerTable([response.summary]);
    return;
  }
  if (subcommand === 'render-map' || subcommand === 'dynmap') {
    const serverRef = args._.slice(1).join(' ').trim();
    printTitle('Cubeflare Dynmap Render');
    const spinner = createSpinner(serverRef ? `Starting map render for ${serverRef}` : 'Starting map render');
    spinner.start();
    const response = await apiJson(origin, '/api/cli/servers/dynmap/render', {
      method: 'POST',
      token: config.token,
      body: { server: serverRef || undefined }
    });
    spinner.succeed('Dynmap render queued');
    console.log(`${color.dim('Command')} ${response.command}`);
    if (response.output) console.log(`${color.dim('Dynmap')}  ${compact(response.output)}`);
    return;
  }
  if (subcommand === 'invite') {
    const serverRef = args._.slice(1).join(' ').trim();
    const response = await apiJson(origin, '/api/cli/servers/invite', {
      method: 'POST',
      token: config.token,
      body: {
        server: serverRef || undefined,
        prefix: args.prefix || undefined,
        rotate: Boolean(args.rotate)
      }
    });
    printTitle('Cubeflare Server Invite');
    printBox('Invite', [
      ['Server', response.host],
      ['Code', response.inviteCode],
      ['Command', response.command],
      ['Expiry', response.expiresAt || 'none']
    ]);
    return;
  }
  if (args._.length) {
    throw new CliError(`Unknown servers command "${args._.join(' ')}". Try cubeflare servers start <server name>.`);
  }
  const response = await apiJson(origin, '/api/cli/servers', {
    token: config.token
  });
  printTitle('Cubeflare Servers');
  if (!response.servers.length) {
    console.log('No servers yet.');
    return;
  }
  printServerTable(response.servers);
}

async function commandWhoami(argv) {
  const args = parseOptions(argv, {
    origin: 'value',
    help: 'boolean',
    h: 'boolean'
  });
  if (args.help || args.h) {
    console.log('Usage: cubeflare whoami [--origin <url>]');
    return;
  }
  const config = await requireConfig();
  const origin = normalizeOrigin(args.origin || config.origin || DEFAULT_ORIGIN);
  const response = await apiJson(origin, '/api/cli/me', {
    token: config.token
  });
  printTitle('Cubeflare Account');
  console.log(`${color.dim('Email')}  ${response.user.email}`);
  console.log(`${color.dim('Origin')} ${origin}`);
  console.log(`${color.dim('Token')}  expires ${formatTime(config.expiresAt)}`);
}

async function commandLogout(argv) {
  const args = parseOptions(argv, {
    origin: 'value',
    local: 'boolean',
    help: 'boolean',
    h: 'boolean'
  });
  if (args.help || args.h) {
    console.log('Usage: cubeflare logout [--local]');
    return;
  }
  const config = await readConfig();
  if (config?.token && !args.local) {
    const origin = normalizeOrigin(args.origin || config.origin || DEFAULT_ORIGIN);
    await apiJson(origin, '/api/cli/logout', {
      method: 'POST',
      token: config.token,
      body: {}
    }).catch(() => undefined);
  }
  await fs.rm(CONFIG_FILE, { force: true });
  console.log('Signed out of Cubeflare CLI.');
}

async function prepareBridgeSession(input) {
  const spinner = createSpinner('Opening Cubeflare bridge session');
  spinner.start();
  let closed = false;
  let lastProgressText = '';

  const progressLoop = (async () => {
    while (!closed) {
      await delay(2000);
      if (closed) break;
      const progress = await fetchConnectorProgress(input).catch(() => null);
      const text = progress ? formatConnectorProgress(progress) : '';
      if (text && text !== lastProgressText) {
        lastProgressText = text;
        spinner.update(text);
      }
    }
  })();

  try {
    const session = await openBridgeSession(input);
    closed = true;
    await progressLoop.catch(() => undefined);
    spinner.succeed('Server bridge is ready');
    return session;
  } catch (error) {
    closed = true;
    await progressLoop.catch(() => undefined);
    spinner.fail('Server bridge could not be prepared');
    await fetchConnectorDiagnostics(input)
      .then(printDiagnostics)
      .catch(() => undefined);
    throw error;
  }
}

function createActivityReporter(input) {
  let token = input.token || '';
  let activeBridgeConnections = 0;
  let timer = null;
  let pending = false;
  let flushPromise = null;

  const report = () => {
    pending = true;
    if (!flushPromise) {
      flushPromise = flush().finally(() => {
        flushPromise = null;
      });
    }
    return flushPromise;
  };

  const startTimer = () => {
    if (!timer) timer = setInterval(report, 60_000);
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  async function flush() {
    if (!token) return;
    while (pending) {
      pending = false;
      await fetch(`${input.origin}/api/connect/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, activeConnections: activeBridgeConnections })
      }).catch(() => undefined);
    }
  }

  function setActiveBridgeConnections(next) {
    activeBridgeConnections = Math.max(0, next);
    if (activeBridgeConnections > 0) startTimer();
    else stopTimer();
    return report();
  }

  return {
    useSession(session) {
      if (session?.activityToken) token = session.activityToken;
    },
    acquire() {
      let released = false;
      void setActiveBridgeConnections(activeBridgeConnections + 1);
      return () => {
        if (released) return;
        released = true;
        void setActiveBridgeConnections(activeBridgeConnections - 1);
      };
    },
    async close() {
      stopTimer();
      await setActiveBridgeConnections(0);
    }
  };
}

async function handleClient(client, openSession) {
  let bridge = null;
  let closed = false;
  let bufferedBytes = 0;
  const pending = [];

  const closeBridge = () => bridge?.close();
  client.on('close', () => {
    closed = true;
    closeBridge();
  });
  client.on('error', () => {
    closed = true;
    closeBridge();
  });

  client.on('data', (chunk) => {
    if (bridge) {
      bridge.send(chunk);
      return;
    }
    bufferedBytes += chunk.length;
    if (bufferedBytes > MAX_BUFFERED_BYTES) {
      client.destroy(new Error('Too much data arrived before the bridge was ready'));
      return;
    }
    pending.push(Buffer.from(chunk));
  });

  const session = await openSession();
  if (closed) return;
  bridge = await connectWebSocket(session.bridgeUrl, session.bridgeToken);
  if (closed) {
    bridge.close();
    return;
  }

  bridge.onData = (data) => client.write(data);
  bridge.onClose = () => client.end();

  for (const chunk of pending.splice(0)) {
    bridge.send(chunk);
  }
}

async function openBridgeSession(input) {
  const response = await fetch(`${input.origin}/api/connect/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: input.inviteCode, server: input.server })
  });
  if (!response.ok) {
    throw new Error(`session failed: ${response.status} ${compact(await response.text())}`);
  }
  const body = await response.json();
  if (!body?.bridgeUrl || !body?.bridgeToken) {
    throw new Error('session response did not include a bridge endpoint');
  }
  return body;
}

async function fetchConnectorDiagnostics(input) {
  const response = await fetch(`${input.origin}/api/connect/diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: input.inviteCode, server: input.server })
  });
  if (!response.ok) {
    throw new Error(`diagnostics failed: ${response.status} ${compact(await response.text())}`);
  }
  return response.json();
}

async function fetchConnectorProgress(input) {
  const response = await fetch(`${input.origin}/api/connect/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: input.inviteCode, server: input.server })
  });
  if (!response.ok) return null;
  return response.json();
}

function formatConnectorProgress(body) {
  const lifecycle = body.lifecycle || body.summary?.lifecycle;
  if (!lifecycle) {
    const status = body.summary?.status;
    return status ? `Server ${status}` : '';
  }
  const parts = [lifecycle.label || lifecycle.key];
  if (lifecycle.elapsedMs >= 1000) parts.push(`${formatDuration(lifecycle.elapsedMs)}`);
  if (lifecycle.backupId) parts.push(`backup ${shortId(lifecycle.backupId)}`);
  if (lifecycle.lastCompletedStep?.durationMs >= 1000) {
    parts.push(`last ${lifecycle.lastCompletedStep.label} ${formatDuration(lifecycle.lastCompletedStep.durationMs)}`);
  }
  return parts.join(' · ');
}

function printDiagnostics(body) {
  console.log('');
  printBox('Diagnostics', [
    ['Status', body.summary?.status ?? 'unknown'],
    ['Process', body.runtime?.process ?? 'unknown'],
    ['Container', body.runtime?.containerRunning ? 'running' : 'asleep'],
    ['RCON', body.runtime?.rconHealthy ? 'ready' : 'not ready'],
    ['Phase', body.lifecycle?.label ?? body.summary?.lifecycle?.label ?? 'unknown'],
    ['Latest event', Array.isArray(body.events) && body.events[0] ? body.events[0].type : 'none']
  ]);
  const stderr = lastUsefulLine(body.logs?.stderrTail || '');
  if (stderr) console.log(`${color.dim('Latest stderr')} ${stderr}`);
}

async function apiJson(origin, apiPath, options = {}) {
  const headers = new Headers({
    'User-Agent': 'cubeflare-cli'
  });
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${origin}${apiPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error?.message || compact(text) || response.statusText;
    const detail = body?.error?.detail;
    throw new CliError(detail ? `${message}\n${formatDetail(detail)}` : message);
  }
  return body;
}

async function connectWebSocket(url, token) {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'wss:';
  const port = Number(parsed.port || (secure ? 443 : 80));
  const socket = secure
    ? tls.connect(port, parsed.hostname, { servername: parsed.hostname })
    : net.connect(port, parsed.hostname);

  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  const key = crypto.randomBytes(16).toString('base64');
  socket.write(
    [
      `GET ${parsed.pathname || '/'}${parsed.search} HTTP/1.1`,
      `Host: ${parsed.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `x-cubeflare-bridge-token: ${token}`,
      '\r\n'
    ].join('\r\n')
  );

  let buffer = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      socket.off('data', onData);
      const headers = buffer.subarray(0, headerEnd).toString('utf8');
      if (!headers.startsWith('HTTP/1.1 101')) {
        reject(new Error(`websocket upgrade failed: ${headers.split('\n')[0]}`));
        return;
      }
      buffer = buffer.subarray(headerEnd + 4);
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });

  const pendingFrames = [];
  const bridge = {
    _onData: undefined,
    get onData() {
      return this._onData;
    },
    set onData(handler) {
      this._onData = handler;
      if (!handler) return;
      while (pendingFrames.length > 0) {
        handler(pendingFrames.shift());
      }
    },
    onClose: undefined,
    send(payload) {
      socket.write(writeClientFrame(payload));
    },
    close() {
      socket.end();
    }
  };

  const deliverFrame = (payload) => {
    if (bridge.onData) bridge.onData(payload);
    else pendingFrames.push(Buffer.from(payload));
  };

  const processServerFrames = () => {
    for (;;) {
      const frame = readServerFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        bridge.onClose?.();
        socket.end();
        return;
      }
      if (frame.opcode === 0x2 || frame.opcode === 0x0) {
        deliverFrame(frame.payload);
      }
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processServerFrames();
  });
  socket.on('close', () => bridge.onClose?.());
  socket.on('error', () => bridge.onClose?.());
  processServerFrames();

  return bridge;
}

function writeClientFrame(payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x82, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function readServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = buffer.readUInt32BE(offset) * 2 ** 32 + buffer.readUInt32BE(offset + 4);
    offset += 8;
  }

  if (buffer.length < offset + length) return null;
  return {
    opcode,
    payload: buffer.subarray(offset, offset + length),
    consumed: offset + length
  };
}

async function requireConfig() {
  const config = await readConfig();
  if (!config?.token) {
    throw new CliError('Not signed in. Run cubeflare auth, or use cubeflare connect <invite-code>.');
  }
  if (config.expiresAt && Date.parse(config.expiresAt) <= Date.now()) {
    throw new CliError('Your Cubeflare CLI login expired. Run cubeflare auth again.');
  }
  return config;
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(CONFIG_FILE, 0o600).catch(() => undefined);
}

async function requirePortAvailable(host, port) {
  const available = await canListen(host, port);
  if (!available) throw new CliError(`Local port ${host}:${port} is already in use.`);
  return port;
}

async function findAvailablePort(host, preferred) {
  for (let offset = 0; offset < 200; offset += 1) {
    const port = AUTO_PORT_BASE + ((preferred - AUTO_PORT_BASE + offset) % AUTO_PORT_SPAN);
    if (await canListen(host, port)) return port;
  }
  throw new CliError('Could not find an available local port.');
}

async function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function preferredServerPort(value) {
  const hash = crypto.createHash('sha256').update(String(value)).digest();
  return AUTO_PORT_BASE + (hash.readUInt32BE(0) % AUTO_PORT_SPAN);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid port: ${value}`);
  }
  return port;
}

function isConnectorInviteCode(value) {
  return Boolean(normalizeConnectorInviteCode(value));
}

function normalizeConnectorInviteCode(value) {
  const normalized = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const parts = normalized.split('-');
  if (parts.length < 2 + CONNECTOR_INVITE_SUFFIX_GROUPS || parts[0] !== 'CF') return '';
  const suffixGroups = parts.slice(-CONNECTOR_INVITE_SUFFIX_GROUPS);
  const prefixGroups = parts.slice(1, -CONNECTOR_INVITE_SUFFIX_GROUPS);
  const prefix = prefixGroups.join('-');
  const body = suffixGroups.join('');
  if (prefix.length < 3 || prefix.length > 40) return '';
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(prefix)) return '';
  if (body.length !== CONNECTOR_INVITE_SUFFIX_LENGTH) return '';
  if (!new RegExp(`^[${CONNECTOR_INVITE_ALPHABET}]+$`).test(body)) return '';
  const groups = [];
  for (let index = 0; index < body.length; index += 4) {
    groups.push(body.slice(index, index + 4));
  }
  return `CF-${prefix}-${groups.join('-')}`;
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('--origin must be an HTTP(S) URL');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeCommand(command) {
  if (!command || command === '--help' || command === '-h') return 'help';
  return command.toLowerCase();
}

function parseOptions(argv, schema) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      values._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      values._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = schema[key];
    if (!kind) throw new CliError(`Invalid argument: --${key}`);
    if (kind === 'boolean') {
      values[key] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (!value) throw new CliError(`Missing value for --${key}`);
    values[key] = value;
  }
  return values;
}

function createSpinner(initialText) {
  const frames = ['-', '\\', '|', '/'];
  let index = 0;
  let text = initialText;
  let timer = null;
  let active = false;

  const render = () => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\r${color.cyan(frames[index % frames.length])} ${text}`);
    index += 1;
  };

  return {
    start() {
      if (!process.stdout.isTTY) {
        console.log(`${color.gray('...')} ${text}`);
        return;
      }
      active = true;
      render();
      timer = setInterval(render, 120);
    },
    update(nextText) {
      text = nextText;
      if (!process.stdout.isTTY) {
        console.log(`${color.gray('...')} ${text}`);
      }
    },
    succeed(message) {
      if (timer) clearInterval(timer);
      if (active && process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      console.log(`${color.green('[ok]')} ${message}`);
      active = false;
    },
    fail(message) {
      if (timer) clearInterval(timer);
      if (active && process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      console.log(`${color.red('[failed]')} ${message}`);
      active = false;
    }
  };
}

function openBrowser(url) {
  const platform = process.platform;
  const candidates =
    platform === 'darwin'
      ? [['open', [url]]]
      : platform === 'win32'
        ? [['cmd', ['/c', 'start', '', url]]]
        : [['xdg-open', [url]], ['sensible-browser', [url]]];

  for (const [command, args] of candidates) {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.unref();
      return true;
    } catch {
      // Try the next opener.
    }
  }
  return false;
}

function printTitle(title) {
  console.log(color.bold(color.cyan(title)));
  console.log(color.gray('-'.repeat(title.length)));
}

function printBox(title, rows) {
  const normalizedRows = rows.map(([label, value]) => [String(label), String(value)]);
  const width = Math.max(title.length, ...normalizedRows.map(([label, value]) => label.length + value.length + 3));
  console.log(color.green(`+ ${title} ${'-'.repeat(Math.max(0, width - title.length - 1))}+`));
  for (const [label, value] of normalizedRows) {
    console.log(`${color.green('|')} ${color.dim(label.padEnd(17))} ${value}`);
  }
  console.log(color.green(`+${'-'.repeat(width + 2)}+`));
}

function printServerTable(servers) {
  const nameWidth = Math.max(6, ...servers.map((server) => server.name.length));
  const statusWidth = Math.max(6, ...servers.map((server) => server.status.length));
  console.log(`${color.dim('Name'.padEnd(nameWidth))}  ${color.dim('Status'.padEnd(statusWidth))}  ${color.dim('Bridge')}  ${color.dim('Players')}  ${color.dim('Version')}`);
  for (const server of servers) {
    const statusColor = server.status === 'running' ? color.green : server.status === 'error' ? color.red : color.yellow;
    const bridgeConnections = Number.isFinite(server.activeBridgeConnections)
      ? server.activeBridgeConnections
      : 0;
    console.log(
      `${server.name.padEnd(nameWidth)}  ${statusColor(server.status.padEnd(statusWidth))}  ${String(bridgeConnections).padStart(2)}      ${String(server.playersOnline ?? 0).padStart(2)}/${String(server.maxPlayers).padEnd(2)}    ${server.preset}/${server.version}`
    );
  }
}

function printUsage() {
  printTitle('Cubeflare CLI');
  console.log('Usage: cubeflare <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  auth                 Sign in through the browser');
  console.log('  connect <server>     Connect to a server by name after auth');
  console.log('  connect <code>       Connect with a server invite code');
  console.log('  servers              List your Minecraft servers');
  console.log('  servers render-map   Start a Dynmap render');
  console.log('  whoami               Show the signed-in account');
  console.log('  logout               Remove local CLI credentials');
}

function printAuthUsage() {
  console.log('Usage: cubeflare auth [--origin <url>] [--no-browser]');
}

function printConnectUsage() {
  console.log('Usage: cubeflare connect <server name>');
  console.log('       cubeflare connect <invite-code>');
  console.log('');
  console.log('Options:');
  console.log('  --origin <url>   Cubeflare Worker origin');
  console.log('  --code <code>    Server invite code');
  console.log('  --host <host>    Local bind host, default 127.0.0.1');
  console.log('  --port <port>    Explicit local port; otherwise a per-server port is chosen');
}

function printServersUsage() {
  console.log('Usage: cubeflare servers [--origin <url>]');
  console.log('       cubeflare servers start [server name] [--origin <url>]');
  console.log('       cubeflare servers render-map [server name] [--origin <url>]');
  console.log('       cubeflare servers invite [server name] [--prefix <words>] [--rotate] [--origin <url>]');
}

function formatDetail(detail) {
  if (!Array.isArray(detail)) return compact(JSON.stringify(detail));
  return detail
    .slice(0, 8)
    .map((item) => `  - ${item.name || item.id || JSON.stringify(item)}`)
    .join('\n');
}

function formatTime(value) {
  if (!value) return 'unknown';
  return new Date(value).toLocaleString();
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 12) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function lastUsefulLine(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0] || '';
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function ansi(open, close) {
  return (value) => (colorEnabled ? `\x1b[${open}m${value}\x1b[${close}m` : String(value));
}

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export { createActivityReporter };
