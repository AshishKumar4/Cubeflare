export const MINECRAFT_SERVER_DIR = '/workspace/server';

const IMMUTABLE_RUNTIME_PATHS = [
  'server.jar',
  'libraries',
  'versions',
  'cache',
  '.paper-remapped',
  '.mixin.out'
] as const;

const TRANSIENT_PATHS = ['.cubeflare', 'logs', 'crash-reports'] as const;

const EXTRA_EXCLUDE_PATTERNS = ['plugins/dynmap/web/tiles', 'plugins/dynmap/web/tiles/*'] as const;

export function minecraftBackupExcludes(): string[] {
  return [
    ...TRANSIENT_PATHS.flatMap((path) => [path, `${path}/*`]),
    ...IMMUTABLE_RUNTIME_PATHS.flatMap((path) => [path, `${path}/*`]),
    ...EXTRA_EXCLUDE_PATTERNS
  ];
}

export function shouldBackupMinecraftPath(path: string): boolean {
  const normalized = normalizeMinecraftPath(path);
  if (!normalized) return true;

  return ![...TRANSIENT_PATHS, ...IMMUTABLE_RUNTIME_PATHS, 'plugins/dynmap/web/tiles'].some(
    (excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`)
  );
}

function normalizeMinecraftPath(path: string): string {
  return path
    .trim()
    .replace(/^\/workspace\/server\/?/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}
