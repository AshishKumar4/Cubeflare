import { randomBase64Url } from '../crypto';
import type {
  MinecraftServerManifest,
  PluginConfig,
  ServerCreateRequest,
  ServerPatchRequest,
  ServerPreset
} from '../types';
import { cleanMinecraftLocationPreference } from '../../shared/minecraft-locations';
import {
  DEFAULT_MEMORY_MIN,
  DEFAULT_SIMULATION_DISTANCE,
  DEFAULT_VIEW_DISTANCE,
  defaultJavaConfig,
  normalizeMinecraftMemory
} from '../../shared/minecraft-optimization';
import { isBuiltinDynmapSupported } from '../../shared/minecraft-map';
import { DEFAULT_MINECRAFT_VERSION } from './versions';

export const BUILTIN_PLUGINS: PluginConfig[] = [
  {
    id: 'dynmap',
    label: 'Dynmap live map',
    enabled: true,
    filename: 'dynmap.jar',
    source: { type: 'builtin', id: 'dynmap' },
    notes: 'Publishes world tiles to R2 for the embedded live map.'
  }
];

const BUILTIN_PLUGIN_IDS = new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id));

const PRESET_DEFAULTS: Record<
  ServerPreset,
  {
    version: string;
    onlineMode: boolean;
    motd: string;
    serverProperties: Record<string, string | number | boolean>;
  }
> = {
  vanilla: {
    version: DEFAULT_MINECRAFT_VERSION,
    onlineMode: true,
    motd: 'Cubeflare vanilla server',
    serverProperties: optimizedServerProperties()
  },
  paper: {
    version: DEFAULT_MINECRAFT_VERSION,
    onlineMode: true,
    motd: 'Cubeflare Paper server',
    serverProperties: optimizedServerProperties()
  },
  purpur: {
    version: DEFAULT_MINECRAFT_VERSION,
    onlineMode: true,
    motd: 'Cubeflare Purpur server',
    serverProperties: optimizedServerProperties()
  },
  folia: {
    version: DEFAULT_MINECRAFT_VERSION,
    onlineMode: true,
    motd: 'Cubeflare Folia server',
    serverProperties: optimizedServerProperties()
  },
  fabric: {
    version: DEFAULT_MINECRAFT_VERSION,
    onlineMode: true,
    motd: 'Cubeflare Fabric server',
    serverProperties: optimizedServerProperties()
  },
  custom: {
    version: DEFAULT_MINECRAFT_VERSION,
    onlineMode: true,
    motd: 'Cubeflare custom server',
    serverProperties: optimizedServerProperties()
  }
};

export function buildManifest(input: {
  serverId: string;
  ownerId: string;
  request: ServerCreateRequest;
  defaults: {
    version: string;
    memoryMin: string;
    memoryMax: string;
    baseHost: string;
  };
}): MinecraftServerManifest {
  const now = new Date().toISOString();
  const preset = cleanPreset(input.request.preset);
  const presetDefaults = PRESET_DEFAULTS[preset];
  const version = cleanVersion(input.request.version ?? input.defaults.version ?? presetDefaults.version);
  const dynmapSupported = isBuiltinDynmapSupported(preset, version);
  const plugins = mergePlugins(input.request.plugins, dynmapSupported);
  const maxPlayers = clampInt(input.request.maxPlayers, 1, 500, 20);
  const dynmapPrefix = `dynmap/${input.serverId}`;
  const invitePrefix = cleanInvitePrefix(input.request.invitePrefix ?? input.request.name ?? input.serverId);

  return {
    serverId: input.serverId,
    ownerId: input.ownerId,
    name: cleanName(input.request.name ?? 'Minecraft Server'),
    preset,
    version,
    seed: cleanOptional(input.request.seed),
    memoryMin: input.defaults.memoryMin,
    memoryMax: input.defaults.memoryMax,
    java: defaultJavaConfig(preset),
    rconPassword: randomBase64Url(24),
    onlineMode: presetDefaults.onlineMode,
    motd: cleanText(input.request.motd ?? presetDefaults.motd, 120),
    maxPlayers,
    difficulty: cleanEnum(input.request.difficulty, ['peaceful', 'easy', 'normal', 'hard'], 'normal'),
    gameMode: cleanEnum(
      input.request.gameMode,
      ['survival', 'creative', 'adventure', 'spectator'],
      'survival'
    ),
    enableCommandBlock: Boolean(input.request.enableCommandBlock ?? false),
    allowNether: Boolean(input.request.allowNether ?? true),
    viewDistance: clampInt(input.request.viewDistance, 2, 32, DEFAULT_VIEW_DISTANCE),
    simulationDistance: clampInt(input.request.simulationDistance, 2, 32, DEFAULT_SIMULATION_DISTANCE),
    pvp: Boolean(input.request.pvp ?? true),
    whitelist: Boolean(input.request.whitelist ?? false),
    ops: cleanStringList(input.request.ops),
    whitelistPlayers: cleanStringList(input.request.whitelistPlayers),
    plugins,
    modpack: undefined,
    setupScript: cleanOptional(input.request.setupScript),
    serverProperties: {
      ...presetDefaults.serverProperties,
      ...(input.request.serverProperties ?? {})
    },
    network: {
      mode: 'bridge',
      publicBaseHost: input.defaults.baseHost,
      joinHost: `${input.serverId}.${input.defaults.baseHost}`
    },
    invite: {
      prefix: invitePrefix,
      rotation: randomBase64Url(12),
      updatedAt: now
    },
    location: {
      preference: cleanMinecraftLocationPreference(input.request.location)
    },
    dynmap: {
      enabled: canEnableDynmap(preset, version, plugins),
      publicPathPrefix: dynmapPrefix
    },
    createdAt: now,
    updatedAt: now
  };
}

export function patchManifest(
  manifest: MinecraftServerManifest,
  patch: ServerPatchRequest
): MinecraftServerManifest {
  const nextPreset = patch.preset !== undefined ? cleanPreset(patch.preset) : manifest.preset;
  const nextVersion = patch.version !== undefined ? cleanVersion(patch.version) : manifest.version;
  const dynmapSupported = isBuiltinDynmapSupported(nextPreset, nextVersion);
  const nextPlugins =
    patch.plugins !== undefined
      ? mergePlugins(patch.plugins, dynmapSupported)
      : mergePlugins(manifest.plugins, dynmapSupported);
  const requestedDynmapEnabled = patch.dynmap?.enabled ?? manifest.dynmap.enabled;
  const dynmapEnabled = requestedDynmapEnabled && canEnableDynmap(nextPreset, nextVersion, nextPlugins);
  const currentInvite = normalizeInviteConfig(manifest);
  const requestedInvitePrefix = patch.invite?.prefix ?? patch.invitePrefix;
  const nextInvitePrefix =
    requestedInvitePrefix !== undefined
      ? cleanInvitePrefix(requestedInvitePrefix, currentInvite.prefix)
      : currentInvite.prefix;
  const now = new Date().toISOString();
  const rotateInvite = Boolean(patch.invite?.rotate) || nextInvitePrefix !== currentInvite.prefix;
  const next: MinecraftServerManifest = {
    ...manifest,
    name: patch.name !== undefined ? cleanName(patch.name) : manifest.name,
    preset: nextPreset,
    version: nextVersion,
    seed: patch.seed !== undefined ? cleanOptional(patch.seed) : manifest.seed,
    memoryMin: patch.memoryMin !== undefined ? cleanMemory(patch.memoryMin) : manifest.memoryMin,
    memoryMax: patch.memoryMax !== undefined ? cleanMemory(patch.memoryMax) : manifest.memoryMax,
    java:
      patch.preset !== undefined
        ? defaultJavaConfig(nextPreset)
        : manifest.java ?? defaultJavaConfig(nextPreset),
    motd: patch.motd !== undefined ? cleanText(patch.motd, 120) : manifest.motd,
    maxPlayers: patch.maxPlayers !== undefined ? clampInt(patch.maxPlayers, 1, 500, 20) : manifest.maxPlayers,
    difficulty:
      patch.difficulty !== undefined
        ? cleanEnum(patch.difficulty, ['peaceful', 'easy', 'normal', 'hard'], 'normal')
        : manifest.difficulty,
    gameMode:
      patch.gameMode !== undefined
        ? cleanEnum(patch.gameMode, ['survival', 'creative', 'adventure', 'spectator'], 'survival')
        : manifest.gameMode,
    enableCommandBlock:
      patch.enableCommandBlock !== undefined
        ? Boolean(patch.enableCommandBlock)
        : manifest.enableCommandBlock,
    allowNether: patch.allowNether !== undefined ? Boolean(patch.allowNether) : manifest.allowNether,
    viewDistance:
      patch.viewDistance !== undefined
        ? clampInt(patch.viewDistance, 2, 32, manifest.viewDistance)
        : manifest.viewDistance,
    simulationDistance:
      patch.simulationDistance !== undefined
        ? clampInt(patch.simulationDistance, 2, 32, manifest.simulationDistance)
        : manifest.simulationDistance,
    pvp: patch.pvp !== undefined ? Boolean(patch.pvp) : manifest.pvp,
    whitelist: patch.whitelist !== undefined ? Boolean(patch.whitelist) : manifest.whitelist,
    ops: patch.ops !== undefined ? cleanStringList(patch.ops) : manifest.ops,
    whitelistPlayers:
      patch.whitelistPlayers !== undefined
        ? cleanStringList(patch.whitelistPlayers)
        : manifest.whitelistPlayers,
    plugins: nextPlugins,
    setupScript:
      patch.setupScript !== undefined ? cleanOptional(patch.setupScript) : manifest.setupScript,
    serverProperties: {
      ...manifest.serverProperties,
      ...(patch.serverProperties ?? {})
    },
    network: {
      ...manifest.network,
      ...(patch.network ?? {})
    },
    invite: {
      prefix: nextInvitePrefix,
      rotation: rotateInvite ? randomBase64Url(12) : currentInvite.rotation,
      updatedAt: rotateInvite ? now : currentInvite.updatedAt
    },
    location: {
      preference:
        patch.location !== undefined
          ? cleanMinecraftLocationPreference(patch.location)
          : manifest.location?.preference ?? 'auto',
      actual: manifest.location?.actual
    },
    dynmap: {
      ...manifest.dynmap,
      ...(patch.dynmap ?? {}),
      enabled: dynmapEnabled
    },
    updatedAt: now
  };
  return next;
}

export function normalizeManifestCompatibility(
  manifest: MinecraftServerManifest
): MinecraftServerManifest {
  const dynmapSupported = isBuiltinDynmapSupported(manifest.preset, manifest.version);
  const plugins = mergePlugins(manifest.plugins, dynmapSupported);
  const dynmapEnabled =
    manifest.dynmap.enabled && canEnableDynmap(manifest.preset, manifest.version, plugins);
  const invite = normalizeInviteConfig(manifest);
  if (
    dynmapEnabled === manifest.dynmap.enabled &&
    JSON.stringify(plugins) === JSON.stringify(manifest.plugins) &&
    invite === manifest.invite
  ) {
    return manifest;
  }
  return {
    ...manifest,
    plugins,
    invite,
    dynmap: {
      ...manifest.dynmap,
      enabled: dynmapEnabled
    }
  };
}

function optimizedServerProperties(): Record<string, string | number | boolean> {
  return {
    'enable-jmx-monitoring': false,
    'enable-query': false,
    'enable-status': true,
    'hide-online-players': false,
    'network-compression-threshold': 256,
    'sync-chunk-writes': false,
    'use-native-transport': true
  };
}

export function normalizeInviteConfig(manifest: MinecraftServerManifest): MinecraftServerManifest['invite'] {
  const existing = manifest.invite;
  const prefix = cleanInvitePrefix(existing?.prefix ?? manifest.name ?? manifest.serverId);
  const rotation = existing?.rotation || randomBase64Url(12);
  const updatedAt = existing?.updatedAt || manifest.updatedAt || manifest.createdAt;
  if (existing && existing.prefix === prefix && existing.rotation === rotation && existing.updatedAt === updatedAt) {
    return existing;
  }
  return { prefix, rotation, updatedAt };
}

export function cleanInvitePrefix(value: string | undefined, fallback = 'CUBEFLARE'): string {
  const source = cleanText(value || fallback, 80).toUpperCase();
  const words = source
    .split(/[^A-Z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 6);
  const prefix = words.join('-').slice(0, 40).replace(/-+$/g, '');
  return prefix.length >= 3 ? prefix : 'CUBEFLARE';
}

export function mergePlugins(plugins: PluginConfig[] | undefined, includeBuiltinDynmap = true): PluginConfig[] {
  const builtinPlugins = includeBuiltinDynmap ? BUILTIN_PLUGINS : [];
  const byId = new Map(builtinPlugins.map((plugin) => [plugin.id, { ...plugin }]));
  for (const plugin of plugins ?? []) {
    if (!plugin?.id || !plugin.filename || !plugin.source) continue;
    if (plugin.source.type === 'builtin' && !BUILTIN_PLUGIN_IDS.has(plugin.source.id)) continue;
    if (plugin.source.type === 'builtin' && plugin.source.id === 'dynmap' && !includeBuiltinDynmap) continue;
    byId.set(plugin.id, {
      id: cleanText(plugin.id, 80),
      label: cleanText(plugin.label || plugin.id, 120),
      enabled: Boolean(plugin.enabled),
      source: plugin.source,
      filename: cleanFilename(plugin.filename),
      notes: plugin.notes ? cleanText(plugin.notes, 240) : undefined
    });
  }
  return [...byId.values()];
}

function hasEnabledDynmapPlugin(plugins: PluginConfig[] | undefined): boolean {
  return (plugins ?? []).some(
    (plugin) => plugin.enabled && cleanFilename(plugin.filename) === 'dynmap.jar'
  );
}

function canEnableDynmap(_preset: ServerPreset, _version: string, plugins: PluginConfig[]): boolean {
  return hasEnabledDynmapPlugin(plugins);
}

function cleanPreset(value: unknown): ServerPreset {
  if (
    value === 'vanilla' ||
    value === 'paper' ||
    value === 'purpur' ||
    value === 'folia' ||
    value === 'fabric' ||
    value === 'custom'
  ) {
    return value;
  }
  return 'paper';
}

function cleanName(value: string): string {
  return cleanText(value, 80) || 'Minecraft Server';
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanOptional(value: unknown): string | undefined {
  const cleaned = cleanText(value, 4000);
  return cleaned || undefined;
}

function cleanVersion(value: unknown): string {
  const cleaned = cleanText(value, 32);
  if (!/^\d+\.\d+(\.\d+)?([+-][\w.-]+)?$/.test(cleaned)) return DEFAULT_MINECRAFT_VERSION;
  return cleaned;
}

function cleanMemory(value: string): string {
  return normalizeMinecraftMemory(value, DEFAULT_MEMORY_MIN);
}

function cleanFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 160) || 'plugin.jar';
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, 200);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
