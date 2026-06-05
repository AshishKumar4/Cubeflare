import type { ServerPreset } from '../worker/types';

export const BUILTIN_DYNMAP_MAX_VERSION = '26.1.2';
export const BUILTIN_DYNMAP_SUPPORTED_PRESETS: readonly ServerPreset[] = ['paper', 'purpur'];

export type BuiltinDynmapCompatibility = {
  compatible: boolean;
  message?: string;
};

export function builtinDynmapCompatibility(
  preset: ServerPreset,
  version: string
): BuiltinDynmapCompatibility {
  if (!BUILTIN_DYNMAP_SUPPORTED_PRESETS.includes(preset)) {
    return {
      compatible: false,
      message: `Built-in Dynmap is disabled for ${preset}; it is a Bukkit/Paper plugin.`
    };
  }

  const parsed = parseMinecraftVersion(version);
  if (!parsed || !isAtMost(parsed, parseMinecraftVersion(BUILTIN_DYNMAP_MAX_VERSION)!)) {
    return {
      compatible: false,
      message: `Built-in Dynmap is disabled for Minecraft ${version}; the bundled build supports Paper-compatible servers through ${BUILTIN_DYNMAP_MAX_VERSION}.`
    };
  }

  return { compatible: true };
}

export function isBuiltinDynmapSupported(preset: ServerPreset, version: string): boolean {
  return builtinDynmapCompatibility(preset, version).compatible;
}

function parseMinecraftVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return [
    Number.parseInt(match[1] ?? '', 10),
    Number.parseInt(match[2] ?? '', 10),
    Number.parseInt(match[3] ?? '0', 10)
  ];
}

function isAtMost(candidate: [number, number, number], max: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] < max[i]) return true;
    if (candidate[i] > max[i]) return false;
  }
  return true;
}
