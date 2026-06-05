import { hmacSha256Hex } from './crypto';
import { HttpError } from './http';
import type { AppEnv } from './types';

const MIN_ROOT_SECRET_LENGTH = 32;
const DERIVATION_PREFIX = 'cubeflare:v1';

type SecretPurpose =
  | 'auth.password-pepper'
  | 'cli.token-signing'
  | 'connector.invite-codes'
  | 'connector.activity'
  | 'minecraft.bridge'
  | 'dynmap.sync';

export async function authPasswordPepper(env: AppEnv): Promise<string> {
  return deriveAppSecret(env, 'auth.password-pepper', 'auth_not_configured');
}

export async function cliTokenSecret(env: AppEnv): Promise<string> {
  return deriveAppSecret(env, 'cli.token-signing', 'cli_auth_not_configured');
}

export async function connectorInviteSecret(env: AppEnv): Promise<string> {
  return deriveAppSecret(env, 'connector.invite-codes', 'connector_not_configured');
}

export async function connectorActivitySecret(env: AppEnv): Promise<string> {
  return deriveAppSecret(env, 'connector.activity', 'connector_not_configured');
}

export async function minecraftBridgeSecret(env: AppEnv): Promise<string> {
  return deriveAppSecret(env, 'minecraft.bridge', 'connector_not_configured');
}

export async function dynmapSyncSecret(env: AppEnv): Promise<string> {
  return deriveAppSecret(env, 'dynmap.sync', 'dynmap_sync_not_configured');
}

async function deriveAppSecret(
  env: AppEnv,
  purpose: SecretPurpose,
  code: string
): Promise<string> {
  const root = env.CUBEFLARE_SECRET;
  if (!root || root.length < MIN_ROOT_SECRET_LENGTH) {
    throw new HttpError(
      500,
      code,
      `CUBEFLARE_SECRET must be configured as a Worker secret with at least ${MIN_ROOT_SECRET_LENGTH} characters`
    );
  }
  return hmacSha256Hex(root, `${DERIVATION_PREFIX}:${purpose}`);
}
