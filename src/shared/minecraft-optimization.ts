export type JavaFlagsProfile = 'aikar-g1' | 'modern-g1';
export type OptimizedServerPreset =
  | 'vanilla'
  | 'paper'
  | 'purpur'
  | 'folia'
  | 'fabric'
  | 'custom';

export type MinecraftJavaConfig = {
  runtime: 'temurin-hotspot';
  majorVersion: number;
  flagsProfile: JavaFlagsProfile;
  extraFlags: string[];
};

export const DEFAULT_JAVA_MAJOR_VERSION = 25;
export const MAX_CONTAINER_JAVA_HEAP_GIB = 10;
export const DEFAULT_MEMORY_MIN = '10G';
export const DEFAULT_MEMORY_MAX = '10G';
export const DEFAULT_VIEW_DISTANCE = 12;
export const DEFAULT_SIMULATION_DISTANCE = 10;

export function normalizeMinecraftMemory(value: unknown, fallback = DEFAULT_MEMORY_MIN): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().toUpperCase();
  const match = /^(\d+)([GM])$/.exec(cleaned);
  if (!match) return fallback;
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const unit = match[2];
  const gib = unit === 'G' ? amount : amount / 1024;
  return gib > MAX_CONTAINER_JAVA_HEAP_GIB ? `${MAX_CONTAINER_JAVA_HEAP_GIB}G` : cleaned;
}

export function defaultJavaConfig(preset: OptimizedServerPreset): MinecraftJavaConfig {
  return {
    runtime: 'temurin-hotspot',
    majorVersion: DEFAULT_JAVA_MAJOR_VERSION,
    flagsProfile: defaultJavaFlagsProfile(preset),
    extraFlags: []
  };
}

export function defaultJavaFlagsProfile(preset: OptimizedServerPreset): JavaFlagsProfile {
  return preset === 'paper' || preset === 'purpur' || preset === 'folia'
    ? 'aikar-g1'
    : 'modern-g1';
}
