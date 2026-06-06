import type { AppEnv, MinecraftServerManifest } from './types';

export function publicBaseHostForRequest(env: AppEnv, request: Request | string): string {
  return configuredPublicBaseHost(env) ?? new URL(typeof request === 'string' ? request : request.url).host;
}

export function publicBaseHostForManifest(
  env: AppEnv,
  manifest: MinecraftServerManifest
): string | undefined {
  return (
    cleanHostValue(manifest.network.publicBaseHost) ??
    configuredPublicBaseHost(env) ??
    baseHostFromJoinHost(manifest.network.joinHost, manifest.serverId)
  );
}

export function publicJoinHost(env: AppEnv, manifest: MinecraftServerManifest): string {
  const publicBaseHost = publicBaseHostForManifest(env, manifest);
  return manifest.network.joinHost ?? (publicBaseHost ? `${manifest.serverId}.${publicBaseHost}` : manifest.serverId);
}

export function internalBaseUrlForManifest(env: AppEnv, manifest: MinecraftServerManifest): string {
  const publicBaseHost = publicBaseHostForManifest(env, manifest);
  if (!publicBaseHost) {
    throw new Error('Public base host is not configured for this server');
  }
  return `https://${publicBaseHost}`;
}

export function configuredPublicBaseHost(env: AppEnv): string | undefined {
  return cleanHostValue(env.PUBLIC_BASE_HOST);
}

export function configuredPreviewHostname(env: AppEnv): string | undefined {
  return cleanHostValue(env.PREVIEW_HOSTNAME);
}

export function cleanHostValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const host = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return host || undefined;
}

function baseHostFromJoinHost(joinHost: string | undefined, serverId: string): string | undefined {
  const host = cleanHostValue(joinHost);
  const prefix = `${serverId.toLowerCase()}.`;
  return host?.startsWith(prefix) ? host.slice(prefix.length) : undefined;
}
