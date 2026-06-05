type CloudflareTcpPort = {
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
};

type RconPacket = {
  id: number;
  type: number;
  body: string;
};

const PACKET_TYPE_COMMAND = 2;
const PACKET_TYPE_AUTH = 3;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function executeRcon(
  tcpPort: CloudflareTcpPort,
  password: string,
  command: string,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const socket = tcpPort.connect('localhost:25575');
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void socket.close().catch(() => undefined);
        reject(new Error('RCON timed out'));
      }, timeoutMs);
    });
    return await Promise.race([executeRconExchange(socket, password, command), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await socket.close().catch(() => undefined);
  }
}

async function executeRconExchange(socket: Socket, password: string, command: string): Promise<string> {
  await socket.opened;

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const readerState = { buffer: new Uint8Array(0) };

  await writer.write(encodePacket(1, PACKET_TYPE_AUTH, password));
  const auth = await readPacket(reader, readerState);
  if (auth.id === -1) {
    throw new Error('RCON authentication failed');
  }

  await writer.write(encodePacket(2, PACKET_TYPE_COMMAND, command));
  const response = await readPacket(reader, readerState);
  return response.body;
}

export function parseListResponse(value: string): { online: number; max: number; players: string[] } {
  const match = value.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online:?\s*(.*)$/i);
  if (!match) {
    return { online: 0, max: 0, players: [] };
  }
  const players = match[3]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    online: Number.parseInt(match[1], 10),
    max: Number.parseInt(match[2], 10),
    players
  };
}

function encodePacket(id: number, type: number, body: string): Uint8Array {
  const bodyBytes = TEXT_ENCODER.encode(body);
  const packet = new Uint8Array(4 + 4 + 4 + bodyBytes.length + 2);
  const view = new DataView(packet.buffer);
  view.setInt32(0, bodyBytes.length + 10, true);
  view.setInt32(4, id, true);
  view.setInt32(8, type, true);
  packet.set(bodyBytes, 12);
  packet[12 + bodyBytes.length] = 0;
  packet[13 + bodyBytes.length] = 0;
  return packet;
}

async function readPacket(
  reader: ReadableStreamDefaultReader,
  state: { buffer: Uint8Array }
): Promise<RconPacket> {
  while (state.buffer.length < 4) {
    state.buffer = concat(state.buffer, await readChunk(reader));
  }

  const length = new DataView(state.buffer.buffer, state.buffer.byteOffset, state.buffer.byteLength).getInt32(
    0,
    true
  );
  const totalLength = 4 + length;

  while (state.buffer.length < totalLength) {
    state.buffer = concat(state.buffer, await readChunk(reader));
  }

  const packet = state.buffer.slice(0, totalLength);
  state.buffer = state.buffer.slice(totalLength);

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const id = view.getInt32(4, true);
  const type = view.getInt32(8, true);
  const body = TEXT_DECODER.decode(packet.slice(12, totalLength - 2));
  return { id, type, body };
}

async function readChunk(reader: ReadableStreamDefaultReader): Promise<Uint8Array> {
  const { done, value } = await reader.read();
  if (done || !value) {
    throw new Error('RCON socket closed');
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
