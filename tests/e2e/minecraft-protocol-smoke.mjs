#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BASE = env('BASE', 'https://minecraft.ashishkumarsingh.com').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const PASSWORD = `Cubeflare-e2e-${Date.now()}-password`;
const EMAIL = env('CUBEFLARE_E2E_EMAIL', `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@cubeflare.test`);
const SERVER_NAME = env('CUBEFLARE_E2E_SERVER_NAME', `E2E Protocol ${new Date().toISOString().slice(0, 19)}`);
const PRESET = env('CUBEFLARE_E2E_PRESET', 'paper');
const VERSION = env('CUBEFLARE_E2E_VERSION', '1.21.8');
const LOCAL_PORT = Number(env('CUBEFLARE_E2E_LOCAL_PORT', String(35000 + Math.floor(Math.random() * 10000))));
const STOP_AFTER = env('CUBEFLARE_E2E_STOP_AFTER', 'true') !== 'false';
const CONNECTOR_READY_TIMEOUT_MS = Number(env('CUBEFLARE_E2E_CONNECTOR_TIMEOUT_MS', '600000'));
const PROBE_TIMEOUT_MS = Number(env('CUBEFLARE_E2E_PROBE_TIMEOUT_MS', '120000'));

let cookie = '';
let serverId = '';
let connector = null;

try {
  log(`base=${BASE}`);
  await register();

  const created = await api('/api/servers', {
    method: 'POST',
    body: {
      name: SERVER_NAME,
      preset: PRESET,
      version: VERSION,
      maxPlayers: 2,
      viewDistance: 2,
      simulationDistance: 2,
      plugins: [
        {
          id: 'dynmap',
          label: 'Dynmap live map',
          enabled: false,
          filename: 'dynmap.jar',
          source: { type: 'builtin', id: 'dynmap' }
        }
      ],
      serverProperties: {
        'spawn-protection': 0,
        'enable-query': false
      }
    }
  });
  serverId = created.server.id;
  const joinHost = created.server.joinHost;
  log(`created server id=${serverId} host=${joinHost} preset=${PRESET} version=${VERSION}`);

  const connect = await api(`/api/servers/${serverId}/connect-invite`, {
    method: 'POST',
    body: {}
  });
  log(`received connector invite code=${connect.inviteCode ? 'ready' : 'missing'}`);

  connector = spawn(
    process.execPath,
    [
      'bin/cubeflare.mjs',
      'connect',
      '--origin',
      BASE,
      '--server',
      connect.host,
      '--code',
      connect.inviteCode,
      '--port',
      String(LOCAL_PORT)
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let connectorOutput = '';
  connector.stdout.on('data', (chunk) => {
    connectorOutput += chunk.toString('utf8');
    process.stdout.write(`[connector] ${chunk}`);
  });
  connector.stderr.on('data', (chunk) => {
    connectorOutput += chunk.toString('utf8');
    process.stderr.write(`[connector] ${chunk}`);
  });

  await waitForConnectorReady(connector, () => connectorOutput);
  log(`connector ready on 127.0.0.1:${LOCAL_PORT}`);

  const status = await withTimeout(
    minecraftStatusProbe('127.0.0.1', LOCAL_PORT, connect.host),
    PROBE_TIMEOUT_MS + 5_000,
    'minecraft status probe'
  );
  log(`status version=${status.status.version?.name ?? 'unknown'} players=${status.status.players?.online ?? '?'} max=${status.status.players?.max ?? '?'}`);
  log(`pongLatencyMs=${status.pongLatencyMs}`);
} finally {
  if (connector) {
    connector.kill('SIGINT');
    await Promise.race([once(connector, 'exit'), delay(3000)]).catch(() => undefined);
  }

  if (STOP_AFTER && serverId) {
    await withTimeout(
      api(`/api/servers/${serverId}/stop`, { method: 'POST', body: {} }),
      180_000,
      `server cleanup stop ${serverId}`
    )
      .then(() => log(`stopped server id=${serverId}`))
      .catch((error) => log(`stop failed id=${serverId}: ${error.message}`));
  }
}

async function register() {
  const body = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Cubeflare E2E'
    }
  });
  log(`registered user=${body.user.email}`);
}

async function api(path, init = {}) {
  const headers = new Headers({
    'User-Agent': 'Cubeflare E2E Minecraft Protocol Smoke',
    Origin: ORIGIN
  });
  if (cookie) headers.set('Cookie', cookie);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);

  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });

  rememberCookies(response.headers);

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text in the error.
  }

  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${compact(text)}`);
  }

  return json;
}

function rememberCookies(headers) {
  const setCookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers.get('set-cookie')
        ? [headers.get('set-cookie')]
        : [];
  const next = new Map(cookie.split('; ').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), part.slice(index + 1)];
  }));

  for (const setCookie of setCookies) {
    const first = setCookie.split(';')[0];
    const index = first.indexOf('=');
    if (index > 0) next.set(first.slice(0, index), first.slice(index + 1));
  }

  cookie = [...next.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function waitForConnectorReady(child, getOutput) {
  const start = Date.now();

  while (Date.now() - start < CONNECTOR_READY_TIMEOUT_MS) {
    const output = getOutput();
    if (child.exitCode !== null) {
      throw new Error(`connector exited with ${child.exitCode}: ${compact(output)}`);
    }
    if (output.includes('Minecraft address')) return;
    await delay(1000);
  }

  throw new Error(`connector did not become ready within ${CONNECTOR_READY_TIMEOUT_MS}ms: ${compact(getOutput())}`);
}

async function minecraftStatusProbe(host, port, serverAddress) {
  const socket = net.connect(port, host);
  socket.setTimeout(PROBE_TIMEOUT_MS);
  await once(socket, 'connect');

  const started = Date.now();
  const pingPayload = BigInt(Date.now());
  socket.write(statusHandshake(serverAddress));
  socket.write(packet(Buffer.from([0x00])));

  const statusPacket = await readPacket(socket, PROBE_TIMEOUT_MS);
  if (statusPacket.id !== 0) throw new Error(`expected status packet id 0, got ${statusPacket.id}`);
  const status = JSON.parse(readString(statusPacket.payload, 0).value);

  socket.write(packet(Buffer.concat([writeVarInt(1), writeLong(pingPayload)])));
  const pongPacket = await readPacket(socket, PROBE_TIMEOUT_MS);
  if (pongPacket.id !== 1) throw new Error(`expected pong packet id 1, got ${pongPacket.id}`);
  const pong = pongPacket.payload.readBigInt64BE(0);
  socket.end();

  if (pong !== pingPayload) throw new Error('pong payload did not match ping payload');
  return {
    status,
    pongLatencyMs: Date.now() - started
  };
}

function statusHandshake(serverAddress) {
  const body = Buffer.concat([
    writeVarInt(0),
    writeVarInt(767),
    writeString(serverAddress),
    writeUShort(25565),
    writeVarInt(1)
  ]);
  return packet(body);
}

function packet(body) {
  return Buffer.concat([writeVarInt(body.length), body]);
}

async function readPacket(socket, timeoutMs) {
  const reader = makeSocketReader(socket, timeoutMs);
  const packetLength = await reader.readVarInt();
  const payload = await reader.readBytes(packetLength);
  const packetId = readVarIntFrom(payload, 0);
  return {
    id: packetId.value,
    payload: payload.subarray(packetId.offset)
  };
}

function makeSocketReader(socket, timeoutMs) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let ended = false;
  let error = null;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  socket.on('end', () => {
    ended = true;
    flush();
  });
  socket.on('close', () => {
    ended = true;
    flush();
  });
  socket.on('error', (err) => {
    error = err;
    flush();
  });
  socket.on('timeout', () => {
    error = new Error(`socket timed out after ${timeoutMs}ms`);
    socket.destroy();
    flush();
  });

  return {
    async readBytes(length) {
      while (buffer.length < length) await waitForData();
      const out = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return out;
    },
    async readVarInt() {
      for (;;) {
        const parsed = tryReadVarInt(buffer, 0);
        if (parsed) {
          buffer = buffer.subarray(parsed.offset);
          return parsed.value;
        }
        await waitForData();
      }
    }
  };

  function waitForData() {
    if (error) return Promise.reject(error);
    if (ended && buffer.length === 0) return Promise.reject(new Error('socket closed before packet completed'));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function flush() {
    while (waiters.length) {
      const waiter = waiters.shift();
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}

function writeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([writeVarInt(bytes.length), bytes]);
}

function readString(buffer, offset) {
  const length = readVarIntFrom(buffer, offset);
  const start = length.offset;
  const end = start + length.value;
  return {
    value: buffer.subarray(start, end).toString('utf8'),
    offset: end
  };
}

function writeUShort(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
}

function writeLong(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(value, 0);
  return buffer;
}

function writeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let temp = current & 0x7f;
    current >>>= 7;
    if (current !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (current !== 0);
  return Buffer.from(bytes);
}

function readVarIntFrom(buffer, offset) {
  const parsed = tryReadVarInt(buffer, offset);
  if (!parsed) throw new Error('incomplete VarInt');
  return parsed;
}

function tryReadVarInt(buffer, offset) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buffer.length) return null;
    read = buffer[offset + numRead];
    result |= (read & 0x7f) << (7 * numRead);
    numRead += 1;
    if (numRead > 5) throw new Error('VarInt is too big');
  } while ((read & 0x80) !== 0);
  return { value: result, offset: offset + numRead };
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function log(message) {
  console.log(`[e2e] ${message}`);
}
