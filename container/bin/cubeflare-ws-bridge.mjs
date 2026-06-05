#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const listenPort = Number(process.env.CUBEFLARE_BRIDGE_PORT || 25566);
const mcHost = process.env.CUBEFLARE_MINECRAFT_HOST || '127.0.0.1';
const mcPort = Number(process.env.CUBEFLARE_MINECRAFT_PORT || 25565);
const serverId = process.env.CUBEFLARE_SERVER_ID || '';
const bridgeSecret = process.env.CUBEFLARE_BRIDGE_SECRET || '';
const dynmapSecret = process.env.CUBEFLARE_DYNMAP_SYNC_SECRET || '';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/dynmap-status') {
    if (headerString(req.headers['x-cubeflare-dynmap-secret']) !== dynmapSecret) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    dynmapStatus()
      .then((status) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      })
      .catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.on('upgrade', (req, socket) => {
  const token = headerString(req.headers['x-cubeflare-bridge-token']);
  if (!verifyBridgeToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n')
  );

  const upstream = net.connect(mcPort, mcHost);
  let wsBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    wsBuffer = Buffer.concat([wsBuffer, chunk]);
    for (;;) {
      const frame = readFrame(wsBuffer);
      if (!frame) break;
      wsBuffer = wsBuffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        upstream.end();
        socket.end();
        return;
      }
      if (frame.opcode === 0x2 || frame.opcode === 0x0) {
        upstream.write(frame.payload);
      }
    }
  });

  upstream.on('data', (chunk) => socket.write(writeFrame(chunk)));
  upstream.on('error', () => socket.destroy());
  upstream.on('end', () => socket.end());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`Cubeflare bridge listening on ${listenPort}, forwarding to ${mcHost}:${mcPort}`);
});

function headerString(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function verifyBridgeToken(token) {
  if (!bridgeSecret || !serverId || !token || token.length > 4096) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const [encoded, signature] = parts;
  const expected = crypto
    .createHmac('sha256', bridgeSecret)
    .update(`cubeflare-bridge.${encoded}`)
    .digest('hex');

  if (!timingSafeEqualHex(expected, signature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return (
      payload?.v === 1 &&
      payload.aud === 'cubeflare-bridge' &&
      payload.serverId === serverId &&
      Number.isFinite(payload.exp) &&
      payload.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

function timingSafeEqualHex(left, right) {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    length = high * 2 ** 32 + low;
    offset += 8;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }

  return { opcode, payload, consumed: offset + length };
}

function writeFrame(payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x82, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

async function dynmapStatus() {
  const pluginJar = await fileInfo('/workspace/server/plugins/dynmap.jar');
  const pluginDir = await dirInfo('/workspace/server/plugins/dynmap');
  const webRoot = await dirInfo('/workspace/server/plugins/dynmap/web');
  const webIndex = await fileInfo('/workspace/server/plugins/dynmap/web/index.html');
  const syncStatus = await readJson('/workspace/server/.cubeflare/dynmap-sync-status.json');
  return {
    ok: true,
    pluginJar,
    pluginDir,
    webRoot,
    webIndex,
    syncStatus,
    checkedAt: new Date().toISOString()
  };
}

async function fileInfo(path) {
  try {
    const info = await stat(path);
    return {
      exists: true,
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    };
  } catch {
    return { exists: false };
  }
}

async function dirInfo(path) {
  const info = await fileInfo(path);
  if (!info.exists || info.type !== 'directory') return info;
  const entries = await readdir(path).catch(() => []);
  return {
    ...info,
    entries: entries.slice(0, 40)
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
