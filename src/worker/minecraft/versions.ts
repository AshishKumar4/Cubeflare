import type { ServerPreset } from '../types';

type VersionedPreset = Exclude<ServerPreset, 'custom'>;

export type VersionOption = {
  version: string;
  channel: string;
  releasedAt?: string;
};

export type VersionCatalog = Record<VersionedPreset, VersionOption[]>;

const CATALOG_TTL_MS = 10 * 60 * 1000;

const FALLBACK_MODERN_VERSIONS = [
  '26.2-pre-3',
  '26.2-pre-2',
  '26.2-pre-1',
  '26.2-snapshot-8',
  '26.2-snapshot-7',
  '26.1.2',
  '26.1.2-rc-1',
  '1.21.11',
  '1.21.10',
  '1.21.9',
  '1.21.8',
  '1.21.7',
  '1.21.6',
  '1.21.5',
  '1.21.4',
  '1.20.6',
  '1.20.4',
  '1.20.2',
  '1.20.1',
  '1.19.4',
  '1.18.2'
];
const FALLBACK_PAPER_VERSIONS = [
  '26.1.2',
  '26.1.1',
  '1.21.11',
  '1.21.11-rc3',
  '1.21.11-rc2',
  '1.21.11-rc1',
  '1.21.11-pre5',
  '1.21.11-pre4',
  '1.21.11-pre3',
  '1.21.10',
  '1.21.9',
  '1.21.8',
  '1.21.7',
  '1.21.6',
  '1.21.5',
  '1.21.4',
  '1.20.6',
  '1.20.4'
];
const FALLBACK_FOLIA_VERSIONS = [
  '26.1.2',
  '1.21.11',
  '1.21.8',
  '1.21.6',
  '1.21.5',
  '1.21.4',
  '1.20.6',
  '1.20.4',
  '1.20.2',
  '1.20.1',
  '1.19.4'
];

export const DEFAULT_MINECRAFT_VERSION = '26.1.2';

const FALLBACK_CATALOG: VersionCatalog = {
  vanilla: versionOptions(FALLBACK_MODERN_VERSIONS, {
    latestRelease: '26.1.2',
    latestSnapshot: '26.2-pre-3'
  }),
  paper: versionOptions(FALLBACK_PAPER_VERSIONS),
  purpur: versionOptions(['26.1.2', ...FALLBACK_PAPER_VERSIONS]),
  folia: versionOptions(FALLBACK_FOLIA_VERSIONS),
  fabric: versionOptions(FALLBACK_MODERN_VERSIONS, {
    latestRelease: '26.1.2',
    latestSnapshot: '26.2-pre-3'
  })
};

let cachedCatalog: { expiresAt: number; catalog: VersionCatalog } | null = null;

export async function getVersionCatalog(): Promise<VersionCatalog> {
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.expiresAt > now) return cachedCatalog.catalog;

  const [vanilla, paper, purpur, folia, fabric] = await Promise.all([
    fetchVanillaVersions().catch(() => FALLBACK_CATALOG.vanilla),
    fetchPaperFillVersions('paper').catch(() => FALLBACK_CATALOG.paper),
    fetchPurpurVersions().catch(() => FALLBACK_CATALOG.purpur),
    fetchPaperFillVersions('folia').catch(() => FALLBACK_CATALOG.folia),
    fetchFabricVersions().catch(() => FALLBACK_CATALOG.fabric)
  ]);

  const catalog = { vanilla, paper, purpur, folia, fabric };
  cachedCatalog = { expiresAt: now + CATALOG_TTL_MS, catalog };
  return catalog;
}

async function fetchVanillaVersions(): Promise<VersionOption[]> {
  const manifest = await fetchJson<MojangVersionManifest>(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  );
  const records = manifest.versions
    .filter((entry) => (entry.type === 'release' || entry.type === 'snapshot') && isMinecraftVersion(entry.id))
    .map((entry) => ({
      version: entry.id,
      type: entry.type as VersionRecord['type'],
      releasedAt: entry.releaseTime ?? entry.time
    }));
  return versionOptions(records, {
    latestRelease: manifest.latest.release,
    latestSnapshot: manifest.latest.snapshot
  });
}

async function fetchPaperFillVersions(projectId: 'paper' | 'folia'): Promise<VersionOption[]> {
  const project = await fetchJson<PaperFillProject>(`https://fill.papermc.io/v3/projects/${projectId}`);
  return versionOptions(Object.values(project.versions ?? {}).flat());
}

async function fetchPurpurVersions(): Promise<VersionOption[]> {
  const project = await fetchJson<{ versions?: string[] }>('https://api.purpurmc.org/v2/purpur');
  return versionOptions(project.versions ?? []);
}

async function fetchFabricVersions(): Promise<VersionOption[]> {
  const games = await fetchJson<Array<{ version: string; stable?: boolean }>>(
    'https://meta.fabricmc.net/v2/versions/game'
  );
  return versionOptions(games.map((entry) => ({ version: entry.version, type: entry.stable ? 'release' : 'snapshot' })));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Cubeflare/0.1 (minecraft.ashishkumarsingh.com)'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json();
}

function versionOptions(
  versions: Array<string | VersionRecord>,
  latest?: { latestRelease?: string; latestSnapshot?: string } | string
): VersionOption[] {
  const byVersion = new Map<string, VersionRecord>();
  for (const item of versions) {
    const record = typeof item === 'string' ? { version: item } : item;
    if (!isMinecraftVersion(record.version)) continue;
    if (!byVersion.has(record.version)) byVersion.set(record.version, record);
  }

  const sorted = [...byVersion.values()]
    .sort((a, b) => compareMinecraftVersions(b.version, a.version))
    .slice(0, 120);
  const latestRelease =
    typeof latest === 'string'
      ? latest
      : latest?.latestRelease && isMinecraftVersion(latest.latestRelease)
        ? latest.latestRelease
        : latestStable(sorted);
  const latestSnapshot =
    typeof latest === 'object' && latest.latestSnapshot && isMinecraftVersion(latest.latestSnapshot)
      ? latest.latestSnapshot
      : undefined;

  return sorted.map((record) => ({
    version: record.version,
    channel: versionChannel(record, latestRelease, latestSnapshot),
    ...(record.releasedAt ? { releasedAt: record.releasedAt } : {})
  }));
}

function latestStable(records: Array<{ version: string }>): string | undefined {
  return records.find((record) => !record.version.includes('-'))?.version;
}

function versionChannel(record: VersionRecord, latestRelease?: string, latestSnapshot?: string): string {
  if (record.version === latestSnapshot) return 'latest preview';
  if (record.version === latestRelease) return 'latest release';
  if (record.version.includes('-snapshot')) return 'snapshot';
  if (record.version.includes('-rc')) return 'release candidate';
  if (record.version.includes('-pre')) return 'preview';
  return record.type === 'snapshot' ? 'snapshot' : 'release';
}

function isMinecraftVersion(version: string): boolean {
  const parsed = parseMinecraftVersion(version);
  return Boolean(parsed && parsed.major >= 1);
}

function compareMinecraftVersions(a: string, b: string): number {
  const left = parseMinecraftVersion(a);
  const right = parseMinecraftVersion(b);
  if (!left || !right) return a.localeCompare(b);

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }

  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  if (left.prerelease.kind !== right.prerelease.kind) {
    return prereleaseRank(left.prerelease.kind) - prereleaseRank(right.prerelease.kind);
  }
  return left.prerelease.number - right.prerelease.number;
}

function prereleaseRank(kind: 'snapshot' | 'pre' | 'rc'): number {
  if (kind === 'rc') return 3;
  if (kind === 'pre') return 2;
  return 1;
}

function parseMinecraftVersion(version: string):
  | {
      major: number;
      minor: number;
      patch: number;
      prerelease?: { kind: 'snapshot' | 'pre' | 'rc'; number: number };
    }
  | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(snapshot|pre|rc)-?(\d+))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
    ...(match[4] && match[5]
      ? { prerelease: { kind: match[4] as 'snapshot' | 'pre' | 'rc', number: Number(match[5]) } }
      : {})
  };
}

type VersionRecord = {
  version: string;
  type?: 'release' | 'snapshot';
  releasedAt?: string;
};

type MojangVersionManifest = {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: Array<{
    id: string;
    type: string;
    time?: string;
    releaseTime?: string;
  }>;
};

type PaperFillProject = {
  versions?: Record<string, string[]>;
};
