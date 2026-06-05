import { decodeJson, encodeJson, hmacSha256Hex, randomBase64Url, timingSafeEqual } from './crypto';
import type {
  BridgeTokenPayload,
  CliTokenPayload,
  ConnectorActivityTokenPayload
} from './types';

const BRIDGE_AUD = 'cubeflare-bridge';
const CONNECT_ACTIVITY_AUD = 'cubeflare-cli-connect-activity';
const CLI_AUD = 'cubeflare-cli';

type SignedPayload =
  | BridgeTokenPayload
  | ConnectorActivityTokenPayload
  | CliTokenPayload;

export type SignedToken<T extends SignedPayload> = {
  token: string;
  payload: T;
  expiresAt: string;
};

export async function createBridgeToken(
  secret: string,
  input: { serverId: string; ttlSeconds?: number }
): Promise<SignedToken<BridgeTokenPayload>> {
  const payload: BridgeTokenPayload = {
    v: 1,
    aud: BRIDGE_AUD,
    serverId: input.serverId,
    exp: nowSeconds() + (input.ttlSeconds ?? 120),
    nonce: randomBase64Url(16)
  };
  return signPayload(secret, payload);
}

export async function verifyBridgeToken(secret: string, token: string): Promise<BridgeTokenPayload> {
  return verifySignedToken<BridgeTokenPayload>(secret, token, BRIDGE_AUD);
}

export async function createConnectorActivityToken(
  secret: string,
  input: { serverId: string; host: string; sessionId: string; ttlSeconds?: number }
): Promise<SignedToken<ConnectorActivityTokenPayload>> {
  const payload: ConnectorActivityTokenPayload = {
    v: 1,
    aud: CONNECT_ACTIVITY_AUD,
    serverId: input.serverId,
    host: input.host,
    sessionId: input.sessionId,
    exp: nowSeconds() + (input.ttlSeconds ?? 60 * 60 * 24),
    nonce: randomBase64Url(16)
  };
  return signPayload(secret, payload);
}

export async function verifyConnectorActivityToken(
  secret: string,
  token: string
): Promise<ConnectorActivityTokenPayload> {
  return verifySignedToken<ConnectorActivityTokenPayload>(secret, token, CONNECT_ACTIVITY_AUD);
}

export async function createCliToken(
  secret: string,
  input: { userId: string; ttlSeconds?: number }
): Promise<SignedToken<CliTokenPayload>> {
  const payload: CliTokenPayload = {
    v: 1,
    aud: CLI_AUD,
    userId: input.userId,
    exp: nowSeconds() + (input.ttlSeconds ?? 60 * 60 * 24 * 30),
    nonce: randomBase64Url(16)
  };
  return signPayload(secret, payload);
}

export async function verifyCliToken(secret: string, token: string): Promise<CliTokenPayload> {
  return verifySignedToken<CliTokenPayload>(secret, token, CLI_AUD);
}

async function signPayload<T extends SignedPayload>(secret: string, payload: T): Promise<SignedToken<T>> {
  const encoded = encodeJson(payload);
  const signature = await hmacSha256Hex(secret, `${payload.aud}.${encoded}`);
  return {
    token: `${encoded}.${signature}`,
    payload,
    expiresAt: new Date(payload.exp * 1000).toISOString()
  };
}

async function verifySignedToken<T extends SignedPayload>(
  secret: string,
  token: string,
  audience: T['aud']
): Promise<T> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Token is malformed');
  }

  const [encoded, signature] = parts;
  const expected = await hmacSha256Hex(secret, `${audience}.${encoded}`);
  if (!timingSafeEqual(expected, signature)) {
    throw new Error('Token signature is invalid');
  }

  const payload = decodeJson<T>(encoded);
  if (!payload || payload.v !== 1 || payload.aud !== audience) {
    throw new Error('Token payload is invalid');
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds()) {
    throw new Error('Token has expired');
  }
  return payload;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
