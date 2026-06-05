const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const PASSWORD_KDF = 'pbkdf2-sha256';
const PASSWORD_ITERATIONS = 100_000;

export function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBase64Url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '='
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(value));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = TEXT_ENCODER.encode(a);
  const right = TEXT_ENCODER.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

export async function hashPassword(
  password: string,
  saltBase64Url: string,
  pepper: string
): Promise<string> {
  const digest = await derivePasswordDigest(password, saltBase64Url, pepper, PASSWORD_ITERATIONS);
  return `${PASSWORD_KDF}:i=${PASSWORD_ITERATIONS}:${digest}`;
}

export async function verifyPassword(
  password: string,
  saltBase64Url: string,
  pepper: string,
  storedHash: string
): Promise<boolean> {
  const parsed = parseStoredPasswordHash(storedHash);
  if (!parsed || parsed.iterations > PASSWORD_ITERATIONS) return false;
  const digest = await derivePasswordDigest(password, saltBase64Url, pepper, parsed.iterations);
  return timingSafeEqual(digest, parsed.digest);
}

async function derivePasswordDigest(
  password: string,
  saltBase64Url: string,
  pepper: string,
  iterations: number
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(`${pepper}:${password}`),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(base64UrlDecode(saltBase64Url)),
      iterations
    },
    keyMaterial,
    256
  );
  return base64UrlEncode(new Uint8Array(bits));
}

function parseStoredPasswordHash(value: string): { iterations: number; digest: string } | null {
  if (!value.includes(':')) {
    return { iterations: PASSWORD_ITERATIONS, digest: value };
  }
  const [algorithm, iterationPart, digest] = value.split(':');
  if (algorithm !== PASSWORD_KDF || !iterationPart?.startsWith('i=') || !digest) return null;
  const iterations = Number(iterationPart.slice(2));
  if (!Number.isSafeInteger(iterations) || iterations < 1) return null;
  return { iterations, digest };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function encodeJson<T>(value: T): string {
  return base64UrlEncode(TEXT_ENCODER.encode(JSON.stringify(value)));
}

export function decodeJson<T>(value: string): T {
  return JSON.parse(TEXT_DECODER.decode(base64UrlDecode(value))) as T;
}
