import {
  Activity,
  AlertTriangle,
  ChevronRight,
  CheckCircle2,
  Clock,
  Cloud,
  Copy,
  Cpu,
  DatabaseBackup,
  Edit3,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Gauge,
  Globe2,
  KeyRound,
  Layers,
  ListChecks,
  LogOut,
  Map,
  MapPin,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCcw,
  Save,
  Server,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  Users,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { ApiError, api } from './api';
import type {
  AuthenticatedUser,
  BackupRecord,
  ConnectorInviteResponse,
  MinecraftRuntimeStatus,
  MinecraftServerManifest,
  PluginConfig,
  ServerCreateRequest,
  ServerPatchRequest,
  ServerSummary
} from '../worker/types';
import {
  MINECRAFT_LOCATION_OPTIONS,
  minecraftLocationLabel,
  type MinecraftLocationPreference
} from '../shared/minecraft-locations';
import {
  DEFAULT_MEMORY_MAX,
  DEFAULT_SIMULATION_DISTANCE,
  DEFAULT_VIEW_DISTANCE,
  defaultJavaConfig
} from '../shared/minecraft-optimization';

type Tab = 'overview' | 'console' | 'terminal' | 'backups' | 'plugins' | 'files' | 'map' | 'settings';

type ServerDetail = {
  summary: ServerSummary;
  manifest: MinecraftServerManifest;
  backups: BackupRecord[];
  events: Array<{ type: string; detail: unknown; createdAt: string }>;
};

type PresetsResponse = {
  presets: ServerPresetOption[];
  versions?: VersionCatalog;
  defaultVersions?: Partial<Record<ServerPresetOption, string>>;
  paperVersions?: VersionOption[];
  builtinPlugins: PluginConfig[];
};

type ServerPresetOption = MinecraftServerManifest['preset'];
type VersionedServerPreset = Exclude<ServerPresetOption, 'custom'>;
type VersionOption = { version: string; channel: string; releasedAt?: string };
type VersionCatalog = Partial<Record<VersionedServerPreset, VersionOption[]>>;
type RuntimeLocation = NonNullable<ServerSummary['runtimeLocation']>;

const FALLBACK_VERSION_OPTIONS: VersionOption[] = [
  { version: '26.1.2', channel: 'latest release' },
  { version: '26.1.1', channel: 'release' },
  { version: '1.21.11', channel: 'release' },
  { version: '1.21.10', channel: 'release' },
  { version: '1.21.9', channel: 'release' },
  { version: '1.21.8', channel: 'release' },
  { version: '1.21.7', channel: 'release' },
  { version: '1.21.6', channel: 'release' },
  { version: '1.21.5', channel: 'release' },
  { version: '1.21.4', channel: 'release' },
  { version: '1.20.6', channel: 'release' },
  { version: '1.20.4', channel: 'release' }
];

const TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((module) => ({ default: module.TerminalPanel }))
);

function TerminalPanelLoading() {
  return (
    <section className="terminalPanel">
      <div className="terminalBar">
        <span className="connectionBadge connecting">
          <WifiOff size={15} /> loading
        </span>
      </div>
      <div className="terminalHost" />
    </section>
  );
}

function installCommand(): string {
  return `curl -fsSL ${window.location.origin}/install.sh | sh`;
}

function cliAuthCodeFromLocation(): string {
  if (window.location.pathname !== '/cli/auth') return '';
  return new URLSearchParams(window.location.search).get('code') ?? '';
}

type FileEntry = {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  mode?: string;
  permissions?: {
    readable: boolean;
    writable: boolean;
    executable: boolean;
  };
};

type DynmapInfo = {
  preview: { url: string } | null;
  previewError?: string;
  previewDnsReady: boolean;
  previewHostname: string;
  previewDnsRecord: string;
  r2Path: string;
  enabled: boolean;
  compatible: boolean;
  message?: string;
  mirrored: boolean;
  tilesAvailable: boolean;
  available: boolean;
};

const tabs: Array<[Tab, LucideIcon, string]> = [
  ['overview', Activity, 'Overview'],
  ['console', FileText, 'Console'],
  ['terminal', TerminalSquare, 'Terminal'],
  ['backups', DatabaseBackup, 'Backups'],
  ['plugins', Plug, 'Plugins'],
  ['files', FileText, 'Files'],
  ['map', Map, 'Map'],
  ['settings', Settings, 'Settings']
];

export function App() {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [runtime, setRuntime] = useState<MinecraftRuntimeStatus | null>(null);
  const [logs, setLogs] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorDetail, setErrorDetail] = useState<unknown>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [createOpen, setCreateOpen] = useState(false);
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const cliAuthCode = useMemo(cliAuthCodeFromLocation, []);

  const selected = useMemo(
    () => servers.find((server) => server.id === selectedId) ?? servers[0] ?? null,
    [selectedId, servers]
  );

  const fleetStats = useMemo(() => {
    const running = servers.filter((server) => server.status === 'running').length;
    const connections = servers.reduce((sum, server) => sum + (server.activeBridgeConnections ?? 0), 0);
    const backups = servers.filter((server) => server.lastBackupAt).length;
    return { running, connections, backups };
  }, [servers]);

  useEffect(() => {
    api<{ user: AuthenticatedUser | null }>('/api/me')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
    api<PresetsResponse>('/api/presets')
      .then(setPresets)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshServers().catch(report);
  }, [user]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setRuntime(null);
      setLogs('');
      return;
    }
    setSelectedId(selected.id);
    refreshDetail(selected.id).catch(report);
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => {
      refreshRuntime(selected.id).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [selected?.id]);

  useEffect(() => {
    if (!selected || tab !== 'console') return;
    refreshLogs(selected.id).catch(() => undefined);
  }, [selected?.id, tab]);

  async function refreshServers() {
    const data = await api<{ servers: ServerSummary[] }>('/api/servers');
    setServers(data.servers);
    if (!selectedId && data.servers[0]) setSelectedId(data.servers[0].id);
    return data.servers;
  }

  async function refreshDetail(serverId: string) {
    const data = await api<ServerDetail>(`/api/servers/${serverId}`);
    setDetail(data);
    await refreshRuntime(serverId).catch(() => undefined);
  }

  async function refreshRuntime(serverId: string) {
    const data = await api<{ runtime: MinecraftRuntimeStatus; summary: ServerSummary }>(
      `/api/servers/${serverId}/status`
    );
    setRuntime(data.runtime);
    setServers((current) =>
      current.map((server) => (server.id === data.summary.id ? data.summary : server))
    );
  }

  async function refreshLogs(serverId: string) {
    const data = await api<{ logs: { stdout: string; stderr: string } }>(
      `/api/servers/${serverId}/logs`
    );
    setLogs([data.logs.stdout, data.logs.stderr].filter(Boolean).join('\n'));
  }

  async function mutate<T>(operation: () => Promise<T>, after?: () => Promise<void>) {
    setBusy(true);
    setError('');
    setErrorDetail(null);
    try {
      await operation();
      await refreshServers();
      if (selectedId) await refreshDetail(selectedId);
      if (after) await after();
    } catch (err) {
      report(err);
      await refreshServers().catch(() => undefined);
      if (selectedId) await refreshDetail(selectedId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function markServerStatus(serverId: string, status: ServerSummary['status']) {
    setServers((current) =>
      current.map((server) => (server.id === serverId ? { ...server, status } : server))
    );
    setDetail((current) =>
      current?.summary.id === serverId
        ? { ...current, summary: { ...current.summary, status } }
        : current
    );
  }

  function runServerAction(serverId: string, status: ServerSummary['status'], path: string) {
    markServerStatus(serverId, status);
    return mutate(() => api(path, { method: 'POST' }));
  }

  async function deleteServer(serverId: string) {
    setBusy(true);
    setError('');
    setErrorDetail(null);
    markServerStatus(serverId, 'deleting');
    try {
      await api(`/api/servers/${serverId}`, { method: 'DELETE' });
      const nextServers = await refreshServers();
      const nextSelected = nextServers.find((server) => server.id !== serverId) ?? nextServers[0] ?? null;
      setSelectedId(nextSelected?.id ?? null);
      if (nextSelected) {
        await refreshDetail(nextSelected.id);
      } else {
        setDetail(null);
        setRuntime(null);
        setLogs('');
      }
    } catch (err) {
      report(err);
      await refreshServers().catch(() => undefined);
      if (selectedId) await refreshDetail(selectedId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function createServer(payload: ServerCreateRequest) {
    setBusy(true);
    setError('');
    setErrorDetail(null);
    try {
      const data = await api<{ server: ServerSummary; manifest: MinecraftServerManifest }>(
        '/api/servers',
        {
          method: 'POST',
          body: JSON.stringify(payload)
        }
      );
      await refreshServers();
      setSelectedId(data.server.id);
      setCreateOpen(false);
      await refreshDetail(data.server.id);
    } catch (err) {
      report(err);
      throw err;
    } finally {
      setBusy(false);
    }
  }

  function report(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    setErrorDetail(err instanceof ApiError ? err.detail : null);
  }

  async function submitAuth(payload: { email: string; password: string; displayName?: string }) {
    setError('');
    const data = await api<{ user: AuthenticatedUser }>(
      authMode === 'login' ? '/api/auth/login' : '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    ).catch((err) => {
      report(err);
      throw err;
    });
    setUser(data.user);
  }

  if (cliAuthCode) {
    return (
      <CliAuthScreen
        user={user}
        code={cliAuthCode}
        mode={authMode}
        setMode={setAuthMode}
        error={error}
        onSubmit={submitAuth}
      />
    );
  }

  if (!user) {
    return (
      <LandingScreen
        mode={authMode}
        setMode={setAuthMode}
        error={error}
        onSubmit={submitAuth}
      />
    );
  }

  return (
    <div className="consoleShell">
      <header className="globalTopbar">
        <BrandLockup subtitle="Cloudflare Containers fleet console" />
        <div className="topbarActions">
          <ConnectInstaller />
          <span className="userBadge">
            <KeyRound size={15} />
            {user.email}
          </span>
          <button
            className="iconTextButton subtle"
            onClick={() =>
              mutate(async () => {
                await api('/api/auth/logout', { method: 'POST' });
                setUser(null);
                setServers([]);
                setSelectedId(null);
              })
            }
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </header>

      <main className="fleetConsole">
        <section className="fleetPane">
          <div className="fleetHeader">
            <div>
              <p className="eyebrow">Fleet</p>
              <h1>Worlds</h1>
            </div>
            <button className="iconTextButton primary compactButton" title="Create server" onClick={() => setCreateOpen(true)}>
              <Plus size={18} />
              New
            </button>
          </div>

          <div className="fleetStats">
            <MiniStat label="Running" value={String(fleetStats.running)} />
            <MiniStat label="Connect" value={String(fleetStats.connections)} />
            <MiniStat label="Backed up" value={String(fleetStats.backups)} />
          </div>

          <div className="serverCards">
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                active={server.id === selected?.id}
                busy={busy}
                onSelect={() => setSelectedId(server.id)}
                onStart={() => runServerAction(server.id, 'starting', `/api/servers/${server.id}/start`)}
                onBackup={() =>
                  mutate(() =>
                    api(`/api/servers/${server.id}/backups`, {
                      method: 'POST',
                      body: JSON.stringify({ reason: 'fleet-card' })
                    })
                  )
                }
              />
            ))}
          </div>

          {!servers.length && <FleetEmpty onCreate={() => setCreateOpen(true)} />}
        </section>

        <section className="detailPane">
          {error && <ErrorBanner message={error} detail={errorDetail} />}
          {!selected || !detail ? (
            <DashboardWelcome onCreate={() => setCreateOpen(true)} />
          ) : (
            <ServerCockpit
              detail={detail}
              runtime={runtime}
              logs={logs}
              tab={tab}
              setTab={setTab}
              busy={busy}
              onRefresh={() => refreshDetail(selected.id)}
              onStart={() => runServerAction(selected.id, 'starting', `/api/servers/${selected.id}/start`)}
              onRestart={() =>
                runServerAction(selected.id, 'starting', `/api/servers/${selected.id}/restart`)
              }
              onStop={() => runServerAction(selected.id, 'stopping', `/api/servers/${selected.id}/stop`)}
              onBackup={() =>
                mutate(() =>
                  api(`/api/servers/${selected.id}/backups`, {
                    method: 'POST',
                    body: JSON.stringify({ reason: 'ui' })
                  })
                )
              }
              onRefreshLogs={() => refreshLogs(selected.id)}
              onCommand={(command) =>
                mutate(async () => {
                  const result = await api<{ output: string }>(`/api/servers/${selected.id}/rcon`, {
                    method: 'POST',
                    body: JSON.stringify({ command })
                  });
                  setLogs((current) => `${current}\n> ${command}\n${result.output}`);
                })
              }
              onRestore={(backupId) =>
                mutate(() =>
                  api(`/api/servers/${selected.id}/backups/${backupId}/restore`, {
                    method: 'POST'
                  })
                )
              }
              onSave={(patch) =>
                mutate(() =>
                  api(`/api/servers/${selected.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(patch)
                  })
                )
              }
              onDelete={() => deleteServer(selected.id)}
            />
          )}
        </section>
      </main>

      {createOpen && (
        <CreateServerDialog
          presets={presets}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onCreate={createServer}
        />
      )}
    </div>
  );
}

function ConnectInstaller() {
  const [open, setOpen] = useState(false);
  const command = installCommand();

  return (
    <div className="connectInstaller">
      <button className="iconTextButton subtle" onClick={() => setOpen((value) => !value)}>
        <Plug size={16} /> Install CLI
      </button>
      {open && (
        <div className="installerMenu">
          <p className="eyebrow">One-time setup</p>
          <CommandCopyRow label="Install CLI" command={command} />
          <CommandCopyRow label="Sign in CLI" command="cubeflare auth" />
        </div>
      )}
    </div>
  );
}

function CliAuthScreen({
  user,
  code,
  mode,
  setMode,
  error,
  onSubmit
}: {
  user: AuthenticatedUser | null;
  code: string;
  mode: 'login' | 'register';
  setMode: (mode: 'login' | 'register') => void;
  error: string;
  onSubmit: (payload: { email: string; password: string; displayName?: string }) => Promise<void>;
}) {
  const [approvalState, setApprovalState] = useState<'idle' | 'approving' | 'approved'>('idle');
  const [approvalError, setApprovalError] = useState('');

  async function approve() {
    setApprovalState('approving');
    setApprovalError('');
    try {
      await api<{ ok: true; status: string }>('/api/cli/auth/approve', {
        method: 'POST',
        body: JSON.stringify({ userCode: code })
      });
      setApprovalState('approved');
    } catch (err) {
      setApprovalState('idle');
      setApprovalError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="cliAuthShell">
      <nav className="landingNav">
        <BrandLockup subtitle="CLI authorization" />
        <a className="iconTextButton subtle" href="/">
          <ChevronRight size={16} /> Console
        </a>
      </nav>

      <section className="cliAuthPanel">
        <div className="cliAuthCard">
          <p className="eyebrow">Cubeflare CLI</p>
          <h1>Authorize terminal access</h1>
          <p>
            Approve this code to let the local Cubeflare CLI list your servers and create
            short-lived connector sessions.
          </p>
          <code className="cliAuthCode">{code}</code>
          {user ? (
            <div className="cliApproveBlock">
              <span className="userBadge">
                <KeyRound size={15} />
                {user.email}
              </span>
              <button className="iconTextButton primary wide" disabled={approvalState !== 'idle'} onClick={approve}>
                {approvalState === 'approved' ? <CheckCircle2 size={17} /> : <KeyRound size={17} />}
                {approvalState === 'approved' ? 'Approved' : approvalState === 'approving' ? 'Approving' : 'Approve CLI'}
              </button>
              {approvalState === 'approved' && (
                <small>The CLI can now finish authentication. You can close this tab.</small>
              )}
              {approvalError && <div className="errorBanner compact">{approvalError}</div>}
            </div>
          ) : (
            <AuthPanel mode={mode} setMode={setMode} error={error} onSubmit={onSubmit} />
          )}
        </div>
      </section>
    </main>
  );
}

function LandingScreen({
  mode,
  setMode,
  error,
  onSubmit
}: {
  mode: 'login' | 'register';
  setMode: (mode: 'login' | 'register') => void;
  error: string;
  onSubmit: (payload: { email: string; password: string; displayName?: string }) => Promise<void>;
}) {
  return (
    <main className="landingShell">
      <nav className="landingNav">
        <BrandLockup subtitle="Persistent Minecraft hosting" />
        <div className="landingLinks">
          <span>Containers</span>
          <span>Backups</span>
          <span>RCON</span>
          <span>Dynmap</span>
        </div>
      </nav>

      <section className="landingHero">
        <div className="heroCopy">
          <p className="eyebrow">Cloudflare-native Minecraft operations</p>
          <h1>Cubeflare</h1>
          <p className="heroLead">
            Run persistent Minecraft worlds with isolated Cloudflare containers, live operations,
            retained backups, RCON, terminal access, plugin control, and map previews in one console.
          </p>
          <div className="heroKpis" aria-label="Platform highlights">
            <span>
              <strong>1:1</strong>
              Server isolation
            </span>
            <span>
              <strong>5</strong>
              Backups retained
            </span>
            <span>
              <strong>24/7</strong>
              Fleet cockpit
            </span>
          </div>
          <div className="heroActions">
            <button className="iconTextButton primary" onClick={() => setMode('register')}>
              <Sparkles size={17} /> Launch fleet
            </button>
            <button className="iconTextButton subtle" onClick={() => setMode('login')}>
              <KeyRound size={17} /> Sign in
            </button>
          </div>
        </div>

        <div className="heroScene" aria-hidden="true">
          <div className="sceneChrome">
            <span />
            <span />
            <span />
          </div>
          <div className="sceneStatus">
            <StatusPill status="running" />
            <strong>play.cubeflare.dev</strong>
          </div>
          <div className="skyline">
            {Array.from({ length: 26 }, (_, index) => (
              <span key={index} style={{ '--i': index } as CSSProperties} />
            ))}
          </div>
          <div className="worldStage">
            <div className="worldGlow" />
            <div className="worldGrid">
              {Array.from({ length: 42 }, (_, index) => (
                <span key={index} className={index % 7 === 0 ? 'lit' : index % 5 === 0 ? 'water' : ''} />
              ))}
            </div>
            <div className="serverTower">
              <span />
              <span />
              <span />
            </div>
            <div className="playerDot one" />
            <div className="playerDot two" />
            <div className="playerDot three" />
          </div>
          <div className="sceneOps">
            <span>
              <TerminalSquare size={15} />
              RCON ready
            </span>
            <span>
              <DatabaseBackup size={15} />
              Backup complete
            </span>
            <span>
              <Users size={15} />
              12 players
            </span>
          </div>
        </div>

        <AuthPanel mode={mode} setMode={setMode} error={error} onSubmit={onSubmit} />
      </section>

      <section className="landingSignals">
        <Signal icon={<DatabaseBackup />} label="Backups" value="5 retained per world" />
        <Signal icon={<Shield />} label="Isolation" value="1 server per Sandbox" />
        <Signal icon={<Cloud />} label="Wake" value="Restore on demand" />
        <Signal icon={<TerminalSquare />} label="Ops" value="Logs, RCON, terminal" />
      </section>
    </main>
  );
}

function AuthPanel({
  mode,
  setMode,
  error,
  onSubmit
}: {
  mode: 'login' | 'register';
  setMode: (mode: 'login' | 'register') => void;
  error: string;
  onSubmit: (payload: { email: string; password: string; displayName?: string }) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  return (
    <form
      className="authPanel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ email, password, displayName });
      }}
    >
      <div>
        <p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Start your fleet'}</p>
        <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
      </div>
      {mode === 'register' && (
        <Field label="Display name">
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder="Alex" />
        </Field>
      )}
      <Field label="Email">
        <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" type="email" placeholder="you@example.com" required />
      </Field>
      <Field label="Password">
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={6}
          required
        />
      </Field>
      {error && <div className="errorBanner compact">{error}</div>}
      <button className="iconTextButton primary wide" type="submit">
        {mode === 'login' ? <KeyRound size={17} /> : <Sparkles size={17} />}
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </button>
      <button
        className="textButton"
        type="button"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login' ? 'Create a new account' : 'Use an existing account'}
      </button>
    </form>
  );
}

function ServerCockpit({
  detail,
  runtime,
  logs,
  tab,
  setTab,
  busy,
  onRefresh,
  onStart,
  onRestart,
  onStop,
  onBackup,
  onRefreshLogs,
  onCommand,
  onRestore,
  onSave,
  onDelete
}: {
  detail: ServerDetail;
  runtime: MinecraftRuntimeStatus | null;
  logs: string;
  tab: Tab;
  setTab: (tab: Tab) => void;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onStart: () => void;
  onRestart: () => void;
  onStop: () => void;
  onBackup: () => void;
  onRefreshLogs: () => void;
  onCommand: (command: string) => void;
  onRestore: (backupId: string) => void;
  onSave: (patch: ServerPatchRequest) => void;
  onDelete: () => void;
}) {
  const status = runtime?.process === 'running' ? 'running' : detail.summary.status;
  const lifecycle = detail.summary.lifecycle;
  const lifecycleText = lifecycle && lifecycle.key !== 'ready'
    ? `${lifecycle.label} · ${formatDuration(lifecycle.elapsedMs)}`
    : '';
  return (
    <div className="serverCockpit">
      <header className="serverHero">
        <div className="serverTitle">
          <div className="serverHeroMeta">
            <StatusPill status={status} />
            <span>{detail.manifest.preset} / {detail.manifest.version}</span>
          </div>
          <h1>{detail.summary.name}</h1>
          <p>{detail.manifest.motd}</p>
          {lifecycleText && <p className="lifecycleLine">{lifecycleText}</p>}
        </div>
        <div className="serverActions">
          <button disabled={busy} className="iconTextButton primary" onClick={onStart}>
            <Power size={16} /> Start or wake
          </button>
          <button disabled={busy} className="iconTextButton" onClick={onRestart}>
            <RefreshCcw size={16} /> Restart
          </button>
          <button disabled={busy} className="iconTextButton" onClick={onStop}>
            <Square size={16} /> Stop
          </button>
          <button disabled={busy} className="iconTextButton" onClick={onBackup}>
            <DatabaseBackup size={16} /> Backup
          </button>
          <button disabled={busy} className="iconButton" title="Refresh" onClick={onRefresh}>
            <RefreshCcw size={17} />
          </button>
        </div>
      </header>

      <section className="cockpitStrip">
        <JoinPanel detail={detail} runtime={runtime} onStart={onStart} />
        <ServerVitals detail={detail} runtime={runtime} />
      </section>

      <nav className="tabs">
        {tabs.map(([name, Icon, label]) => (
          <button className={tab === name ? 'active' : ''} key={name} onClick={() => setTab(name)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <Overview detail={detail} runtime={runtime} />}
      {tab === 'console' && (
        <ConsolePanel
          serverId={detail.summary.id}
          initialLogs={logs}
          active={tab === 'console'}
          onRefresh={onRefreshLogs}
          onCommand={onCommand}
        />
      )}
      {tab === 'terminal' && (
        <Suspense fallback={<TerminalPanelLoading />}>
          <TerminalPanel serverId={detail.summary.id} active={tab === 'terminal'} />
        </Suspense>
      )}
      {tab === 'backups' && <Backups backups={detail.backups} onRestore={onRestore} />}
      {tab === 'plugins' && <Plugins detail={detail} onSave={onSave} />}
      {tab === 'files' && <Files serverId={detail.summary.id} />}
      {tab === 'map' && <MapPanel serverId={detail.summary.id} />}
      {tab === 'settings' && <SettingsPanel detail={detail} onSave={onSave} onDelete={onDelete} />}
    </div>
  );
}

function ServerVitals({ detail, runtime }: { detail: ServerDetail; runtime: MinecraftRuntimeStatus | null }) {
  const process = runtime?.process ?? detail.summary.status;
  const observedLocation = runtime?.location ?? detail.summary.runtimeLocation ?? detail.manifest.location?.actual;
  const container = runtime?.containerRunning ? 'running' : 'asleep';
  const rcon = runtime?.rconHealthy ? 'healthy' : process === 'running' ? 'warming' : 'offline';
  const lifecycle = detail.summary.lifecycle;
  const phase = lifecycle && lifecycle.key !== 'ready'
    ? `${lifecycle.label} ${formatDuration(lifecycle.elapsedMs)}`
    : process;
  return (
    <div className="serverVitals">
      <div className="vitalHeader">
        <span>Live status</span>
        <strong>{phase}</strong>
      </div>
      <div className="vitalGrid">
        <Vital icon={<Users />} label="Bridge" value={`${runtime?.activeBridgeConnections ?? detail.summary.activeBridgeConnections ?? 0} active`} />
        <Vital icon={<TerminalSquare />} label="RCON" value={rcon} tone={runtime?.rconHealthy ? 'good' : 'warn'} />
        <Vital icon={<Cloud />} label="Container" value={container} tone={runtime?.containerRunning ? 'good' : 'warn'} />
        <Vital icon={<MapPin />} label="Location" value={shortLocationLabel(observedLocation, detail.summary.locationPreference ?? detail.manifest.location?.preference)} />
        <Vital icon={<DatabaseBackup />} label="Backup" value={formatCompactTime(detail.summary.lastBackupAt)} tone={detail.summary.lastBackupAt ? 'good' : 'warn'} />
        <Vital icon={<Activity />} label={lifecycle && lifecycle.key !== 'ready' ? 'Phase' : 'Runtime'} value={phase} tone={process === 'running' ? 'good' : process === 'error' ? 'bad' : 'warn'} />
      </div>
    </div>
  );
}

function Vital({
  icon,
  label,
  value,
  tone = 'neutral'
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className={`vital ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function JoinPanel({
  detail,
  runtime,
  onStart
}: {
  detail: ServerDetail;
  runtime: MinecraftRuntimeStatus | null;
  onStart: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectCommand, setConnectCommand] = useState<ConnectorInviteResponse | null>(null);
  const [connectError, setConnectError] = useState('');
  const joinStatus = joinStatusText(detail, runtime);

  useEffect(() => {
    let active = true;
    setConnectBusy(true);
    setConnectError('');
    setConnectCommand(null);
    api<ConnectorInviteResponse>(`/api/servers/${detail.summary.id}/connect-invite`, {
      method: 'POST',
      body: JSON.stringify({})
    })
      .then((response) => {
        if (active) setConnectCommand(response);
      })
      .catch((error) => {
        if (active) setConnectError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setConnectBusy(false);
      });
    return () => {
      active = false;
    };
  }, [detail.summary.id, detail.manifest.invite?.updatedAt]);

  async function refreshInvite(): Promise<ConnectorInviteResponse> {
    setConnectBusy(true);
    setConnectError('');
    try {
      const response = await api<ConnectorInviteResponse>(`/api/servers/${detail.summary.id}/connect-invite`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      setConnectCommand(response);
      return response;
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setConnectBusy(false);
    }
  }

  async function copyConnectCommand() {
    setConnectError('');
    try {
      const invite = connectCommand ?? (await refreshInvite());
      await navigator.clipboard.writeText(`${invite.installCommand}\n${invite.command}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      setCopied(false);
      if (!connectError) setConnectError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="joinPanel">
      <div>
        <p className="eyebrow">Minecraft access</p>
        <strong className="joinTitle">Secure local bridge</strong>
        <span>{joinStatus}</span>
        <div className="connectCommand">
          {connectCommand ? (
            <>
              <CommandCopyRow label="Install CLI once" command={connectCommand.installCommand} />
              <CommandCopyRow label="Open bridge" command={connectCommand.command} />
              <small>
                Invite code {connectCommand.inviteCode} opens a bridge session and stays valid until you change or
                regenerate the server invite.
              </small>
            </>
          ) : (
            <div className="commandLoading">Preparing invite code...</div>
          )}
        </div>
        {connectError && <em className="joinError">{connectError}</em>}
      </div>
      <div className="joinActions">
        <button className="iconTextButton primary" disabled={connectBusy} onClick={copyConnectCommand}>
          {copied ? <CheckCircle2 size={16} /> : <Plug size={16} />}
          {copied ? 'Copied' : connectBusy ? 'Preparing' : 'Copy bridge command'}
        </button>
        <button className="iconTextButton" onClick={onStart}>
          <Play size={16} /> Wake
        </button>
      </div>
    </div>
  );
}

function CommandCopyRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="commandCopyRow">
      <small>{label}</small>
      <div className="commandCopyBox">
        <code title={command}>{command}</code>
        <button className="iconButton commandCopyButton" title={`Copy ${label}`} onClick={copy}>
          {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

function Overview({ detail, runtime }: { detail: ServerDetail; runtime: MinecraftRuntimeStatus | null }) {
  const process = runtime?.process ?? detail.summary.status;
  const rcon = runtime?.rconHealthy ? 'healthy' : 'not ready';
  const container = runtime?.containerRunning ? 'running' : 'asleep';
  const observedLocation = runtime?.location ?? detail.summary.runtimeLocation ?? detail.manifest.location?.actual;
  const java = detail.manifest.java ?? defaultJavaConfig(detail.manifest.preset);
  const lifecycle = detail.summary.lifecycle;
  const lastStep = lifecycle?.lastCompletedStep;
  return (
    <section className="overviewGrid">
        <Panel title="World and access" icon={<Gamepad2 />}>
          <SpecList
            rows={[
              ['Game mode', detail.manifest.gameMode],
              ['Difficulty', detail.manifest.difficulty],
              ['Seed', detail.manifest.seed || 'random'],
              ['PVP', detail.manifest.pvp ? 'enabled' : 'disabled'],
              ['Command blocks', detail.manifest.enableCommandBlock ? 'enabled' : 'disabled'],
              ['Online mode', detail.manifest.onlineMode ? 'enabled' : 'disabled'],
              ['Whitelist', detail.manifest.whitelist ? 'enabled' : 'disabled'],
              ['Operators', String(detail.manifest.ops.length)],
              ['Allowed players', String(detail.manifest.whitelistPlayers.length)]
            ]}
          />
        </Panel>
        <Panel title="Runtime tuning" icon={<Gauge />}>
          <SpecList
            rows={[
              ['Preset', detail.manifest.preset],
              ['Version', detail.manifest.version],
              ['Memory', `${detail.manifest.memoryMin} - ${detail.manifest.memoryMax}`],
              ['Java', `${java.runtime} ${java.majorVersion}`],
              ['JVM profile', java.flagsProfile],
              ['View distance', String(detail.manifest.viewDistance)],
              ['Simulation', String(detail.manifest.simulationDistance)],
              ['Process', process],
              ['RCON', rcon],
              ['Container', container],
              ['Lifecycle', lifecycle ? `${lifecycle.label} (${formatDuration(lifecycle.elapsedMs)})` : 'idle'],
              ['Last step', lastStep ? `${lastStep.label} (${formatDuration(lastStep.durationMs)})` : 'none'],
              ['Latest backup', formatTime(detail.summary.lastBackupAt)]
            ]}
          />
        </Panel>
        <Panel title="Connection" icon={<Globe2 />}>
          <SpecList
            rows={[
              ['Mode', 'Secure CLI bridge'],
              ['Minecraft address', 'shown by the CLI'],
              ['Bridge command', 'copy from access panel'],
              ['Preferred location', minecraftLocationLabel(detail.summary.locationPreference ?? detail.manifest.location?.preference)],
              ['Observed location', fullLocationLabel(observedLocation)]
            ]}
          />
        </Panel>
        <Panel title="Player activity" icon={<Users />}>
          <div className="playerSummary">
            <strong>{runtime?.playersOnline ?? 0}</strong>
            <span>Minecraft players online</span>
          </div>
          <small>{runtime?.activeBridgeConnections ?? detail.summary.activeBridgeConnections ?? 0} active bridge connections</small>
          <div className="playerList">
            {(runtime?.players ?? []).length ? (
              runtime!.players.map((player) => <span key={player}>{player}</span>)
            ) : (
              <small>No Minecraft player names cached</small>
            )}
          </div>
        </Panel>
        <Panel title="Recent activity" icon={<Clock />} className="widePanel">
          <ul className="eventList">
            {detail.events.slice(0, 8).map((event) => (
              <li key={`${event.type}-${event.createdAt}`}>
                <strong>{event.type}</strong>
                <span>{formatTime(event.createdAt)}</span>
              </li>
            ))}
            {!detail.events.length && <li>No lifecycle events yet.</li>}
          </ul>
        </Panel>
      </section>
  );
}

function ConsolePanel({
  serverId,
  initialLogs,
  active,
  onRefresh,
  onCommand
}: {
  serverId: string;
  initialLogs: string;
  active: boolean;
  onRefresh: () => void;
  onCommand: (command: string) => void;
}) {
  const [command, setCommand] = useState('list');
  const [logs, setLogs] = useState(initialLogs);
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'closed' | 'error'>(
    'connecting'
  );
  const snapshotChunks = useRef(new Set<string>());
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    setLogs(initialLogs);
    snapshotChunks.current = new Set(initialLogs ? [initialLogs] : []);
  }, [initialLogs, serverId]);

  useEffect(() => {
    if (!active) return;
    setStreamState('connecting');
    const source = new EventSource(`/api/servers/${serverId}/logs/stream`);

    source.onopen = () => setStreamState('live');
    source.addEventListener('snapshot', (event) => {
      const data = parseSseData<{ stdout?: string; stderr?: string }>(event);
      const chunks = [data?.stdout, data?.stderr].filter(Boolean) as string[];
      snapshotChunks.current = new Set(chunks);
      setLogs(chunks.join('\n'));
    });
    source.addEventListener('notice', (event) => {
      const data = parseSseData<{ data?: string }>(event);
      if (data?.data) appendLogLine(setLogs, `[stream] ${data.data}`);
    });
    source.onmessage = (event) => {
      const payload = parseSseData<{ type?: string; data?: string }>(event);
      if (!payload?.data || payload.type === 'process_info') return;
      if (snapshotChunks.current.has(payload.data)) {
        snapshotChunks.current.delete(payload.data);
        return;
      }
      appendLogLine(setLogs, payload.data);
    };
    source.onerror = () => {
      setStreamState(source.readyState === EventSource.CLOSED ? 'closed' : 'error');
    };

    return () => {
      source.close();
      setStreamState('closed');
    };
  }, [active, serverId]);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [logs]);

  return (
    <section className="consolePanel">
      <div className="panelToolbar">
        <span className={`connectionBadge ${streamState}`}>
          {streamState === 'live' ? <Wifi size={15} /> : <WifiOff size={15} />}
          {streamState}
        </span>
        <button
          className="iconTextButton"
          onClick={() => {
            onRefresh();
            appendLogLine(setLogs, '[snapshot] Manual refresh requested.');
          }}
        >
          <RefreshCcw size={16} /> Snapshot
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            appendLogLine(setLogs, `> ${command}`);
            onCommand(command);
          }}
        >
          <input value={command} onChange={(event) => setCommand(event.target.value)} />
          <button className="iconTextButton primary">
            <TerminalSquare size={16} /> Send RCON
          </button>
        </form>
      </div>
      <pre ref={logRef} className="logView">{logs || 'No logs yet. Start the server to stream process output.'}</pre>
    </section>
  );
}

function Backups({ backups, onRestore }: { backups: BackupRecord[]; onRestore: (backupId: string) => void }) {
  return (
    <section className="tablePanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Restore points</p>
          <h2>Backups</h2>
        </div>
        <span>{backups.length}/5 retained</span>
      </div>
      {backups.map((backup) => (
        <div className="tableRow" key={backup.id}>
          <DatabaseBackup size={18} />
          <span>
            <strong>{backup.reason}</strong>
            <small>{[backup.id, backup.sizeBytes !== undefined ? formatBytes(backup.sizeBytes) : 'size pending'].join(' / ')}</small>
          </span>
          <time>{formatTime(backup.createdAt)}</time>
          <button className="iconTextButton" onClick={() => onRestore(backup.id)}>
            <RefreshCcw size={16} /> Restore
          </button>
        </div>
      ))}
      {!backups.length && <EmptyPanel icon={<DatabaseBackup />} title="No backups yet" text="Start the server or trigger a manual backup to create the first restore point." />}
    </section>
  );
}

function Plugins({
  detail,
  onSave
}: {
  detail: ServerDetail;
  onSave: (patch: ServerPatchRequest) => void;
}) {
  const [plugins, setPlugins] = useState(detail.manifest.plugins);
  useEffect(() => setPlugins(detail.manifest.plugins), [detail.manifest.serverId, detail.manifest.plugins]);
  return (
    <section className="tablePanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Modding</p>
          <h2>Plugins</h2>
        </div>
        <button className="iconTextButton primary" onClick={() => onSave({ plugins })}>
          <Save size={16} /> Save plugins
        </button>
      </div>
      {plugins.map((plugin) => (
        <label className="tableRow pluginRow" key={plugin.id}>
          <Plug size={18} />
          <span>
            <strong>{plugin.label}</strong>
            <small>{plugin.notes ?? plugin.filename}</small>
          </span>
          <span className="pluginSource">{plugin.source.type}</span>
          <input
            type="checkbox"
            checked={plugin.enabled}
            onChange={(event) =>
              setPlugins((current) =>
                current.map((item) =>
                  item.id === plugin.id ? { ...item, enabled: event.target.checked } : item
                )
              )
            }
          />
        </label>
      ))}
      {!plugins.length && <EmptyPanel icon={<Plug />} title="No plugins configured" text="Upload a plugin jar from Files or save built-in plugin selections when presets include them." />}
    </section>
  );
}

function Files({ serverId }: { serverId: string }) {
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPath('');
    setSelected(null);
    setContent('');
    setDirty(false);
  }, [serverId]);

  useEffect(() => {
    loadFiles(path).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [serverId, path]);

  async function loadFiles(targetPath = path) {
    setLoading(true);
    setStatus('');
    try {
      const data = await api<{ files: FileEntry[]; path: string; count: number; timestamp: string }>(
        `/api/servers/${serverId}/files?path=${encodeURIComponent(targetPath || '.')}`
      );
      const sorted = [...data.files].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sorted);
      setStatus(`${data.count} items`);
    } finally {
      setLoading(false);
    }
  }

  async function openEntry(file: FileEntry) {
    if (file.type === 'directory') {
      setPath(normalizeServerPath(file.relativePath || file.absolutePath));
      setSelected(null);
      setContent('');
      setDirty(false);
      return;
    }

    setSelected(file);
    setRenameTo(file.name);
    setDirty(false);
    if (!isEditableFile(file)) {
      setContent('');
      setStatus('Binary or large file selected');
      return;
    }

    const filePath = normalizeServerPath(file.relativePath || file.absolutePath);
    const data = await api<{ content: string }>(
      `/api/servers/${serverId}/files/content?path=${encodeURIComponent(filePath)}`
    );
    setContent(data.content);
    setStatus(`Opened ${file.name}`);
  }

  async function saveContent() {
    if (!selected) return;
    await api(`/api/servers/${serverId}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ path: normalizeServerPath(selected.relativePath || selected.absolutePath), content })
    });
    setDirty(false);
    setStatus(`Saved ${selected.name}`);
  }

  async function createFolder() {
    if (!newFolder.trim()) return;
    await api(`/api/servers/${serverId}/files/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path: joinServerPath(path, newFolder.trim()) })
    });
    setNewFolder('');
    await loadFiles();
  }

  async function renameSelected() {
    if (!selected || !renameTo.trim() || renameTo === selected.name) return;
    const sourcePath = normalizeServerPath(selected.relativePath || selected.absolutePath);
    const destinationPath = joinServerPath(parentServerPath(sourcePath), renameTo.trim());
    await api(`/api/servers/${serverId}/files/move`, {
      method: 'POST',
      body: JSON.stringify({ sourcePath, destinationPath })
    });
    setSelected(null);
    setContent('');
    setDirty(false);
    await loadFiles();
  }

  async function deleteSelected() {
    if (!selected || selected.type !== 'file') return;
    await api(`/api/servers/${serverId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path: normalizeServerPath(selected.relativePath || selected.absolutePath) })
    });
    setSelected(null);
    setContent('');
    setDirty(false);
    await loadFiles();
  }

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setLoading(true);
    setStatus(`Uploading ${fileList.length} file${fileList.length === 1 ? '' : 's'}`);
    try {
      for (const file of Array.from(fileList)) {
        await fetch(
          `/api/servers/${serverId}/files/upload?path=${encodeURIComponent(path || '.')}&filename=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            body: file
          }
        ).then(async (response) => {
          if (!response.ok) throw new Error(await response.text());
        });
      }
      await loadFiles();
    } finally {
      setLoading(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  const breadcrumbs = pathBreadcrumbs(path);
  const editable = selected ? isEditableFile(selected) : false;

  return (
    <section className="fileManager">
      <div className="panel fileBrowser">
        <header>
          <FolderOpen />
          <h2>Files</h2>
          <span className="panelHint">{status || (loading ? 'Loading' : 'Ready')}</span>
        </header>

        <div className="breadcrumbs">
          {breadcrumbs.map((crumb, index) => (
            <button key={crumb.path || 'root'} onClick={() => setPath(crumb.path)}>
              {index > 0 && <ChevronRight size={14} />}
              {crumb.label}
            </button>
          ))}
        </div>

        <div className="fileToolbar">
          <button className="iconTextButton" onClick={() => loadFiles()} disabled={loading}>
            <RefreshCcw size={16} /> Refresh
          </button>
          <button className="iconTextButton" onClick={() => uploadRef.current?.click()} disabled={loading}>
            <Upload size={16} /> Upload
          </button>
          <input ref={uploadRef} className="hiddenInput" type="file" multiple onChange={(event) => uploadFiles(event.target.files)} />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createFolder().catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
            }}
          >
            <input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="Folder name" />
            <button className="iconTextButton">
              <FolderPlus size={16} /> New folder
            </button>
          </form>
        </div>

        <div className="fileTable" role="table">
          <div className="fileTableHead" role="row">
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
          </div>
          {files.map((file) => {
            const relPath = normalizeServerPath(file.relativePath || file.absolutePath);
            const active = selected && normalizeServerPath(selected.relativePath || selected.absolutePath) === relPath;
            return (
              <button
                className={`fileRow ${active ? 'active' : ''}`}
                key={file.absolutePath || relPath || file.name}
                onClick={() => openEntry(file).catch((error) => setStatus(error instanceof Error ? error.message : String(error)))}
              >
                <span>
                  {file.type === 'directory' ? <Folder size={17} /> : <FileIcon size={17} />}
                  <strong>{file.name}</strong>
                </span>
                <small>{file.type === 'directory' ? 'Folder' : formatBytes(file.size)}</small>
                <small>{formatTime(file.modifiedAt)}</small>
              </button>
            );
          })}
        </div>
        {!files.length && !loading && <EmptyPanel icon={<FolderOpen />} title="No files found" text="This directory is empty or the server has not created its files yet." />}
      </div>

      <div className="panel fileInspector">
        <header>
          <FileText />
          <h2>{selected ? selected.name : 'Inspector'}</h2>
          {dirty && <span className="dirtyBadge">unsaved</span>}
        </header>

        {selected ? (
          <>
            <SpecList
              rows={[
                ['Path', normalizeServerPath(selected.relativePath || selected.absolutePath) || '/'],
                ['Type', selected.type],
                ['Size', selected.type === 'directory' ? 'folder' : formatBytes(selected.size)],
                ['Modified', formatTime(selected.modifiedAt)]
              ]}
            />
            <div className="renameStrip">
              <input value={renameTo} onChange={(event) => setRenameTo(event.target.value)} />
              <button className="iconTextButton" onClick={() => renameSelected().catch((error) => setStatus(error instanceof Error ? error.message : String(error)))}>
                <Edit3 size={16} /> Rename
              </button>
              <button className="iconTextButton danger" disabled={selected.type !== 'file'} onClick={() => deleteSelected().catch((error) => setStatus(error instanceof Error ? error.message : String(error)))}>
                <Trash2 size={16} /> Delete
              </button>
            </div>
            {editable ? (
              <>
                <div className="editorToolbar">
                  <button className="iconTextButton primary" disabled={!dirty} onClick={() => saveContent().catch((error) => setStatus(error instanceof Error ? error.message : String(error)))}>
                    <Save size={16} /> Save
                  </button>
                  <span>{content.length.toLocaleString()} chars</span>
                </div>
                <textarea
                  className="fileEditor"
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setDirty(true);
                  }}
                />
              </>
            ) : (
              <EmptyPanel icon={<FileIcon />} title="Preview unavailable" text="Open a small text/config file to edit it here." />
            )}
          </>
        ) : (
          <EmptyPanel icon={<FileText />} title="Select a file" text="Choose a file from the browser to inspect, rename, delete, or edit it." />
        )}
      </div>
    </section>
  );
}

function MapPanel({ serverId }: { serverId: string }) {
  const [info, setInfo] = useState<DynmapInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState('');

  async function loadMap(includePreview = false) {
    setLoading(true);
    try {
      const data = await api<DynmapInfo>(
        `/api/servers/${serverId}/dynmap${includePreview ? '?preview=1' : ''}`
      );
      setInfo(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMap(false).catch(() => setInfo(null));
  }, [serverId]);

  async function renderMap() {
    setRendering(true);
    setRenderError('');
    try {
      await api<{ command: string; output: string }>(`/api/servers/${serverId}/dynmap/render`, {
        method: 'POST'
      });
      await loadMap(false);
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : String(error));
    } finally {
      setRendering(false);
    }
  }

  const mapUrl = info?.available ? info.r2Path : info?.previewDnsReady ? info.preview?.url : undefined;
  const renderDisabled = rendering || loading || info?.enabled === false || info?.compatible === false;

  return (
    <section className="mapPanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">World map</p>
          <h2>Dynmap</h2>
        </div>
        <div className="mapActions">
          <button className="iconTextButton" disabled={loading} onClick={() => loadMap(false)}>
            <RefreshCcw size={16} /> Refresh
          </button>
          <button className="iconTextButton primary" disabled={renderDisabled} onClick={renderMap}>
            <Sparkles size={16} /> {rendering ? 'Rendering' : 'Render map'}
          </button>
          <button
            className="iconTextButton"
            disabled={loading || info?.previewDnsReady === false}
            title={info?.previewDnsReady === false ? 'Preview DNS is not configured' : undefined}
            onClick={() => loadMap(true)}
          >
            <Globe2 size={16} /> Live preview
          </button>
          {mapUrl && (
            <a className="iconTextButton" href={mapUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Open
            </a>
          )}
        </div>
      </div>
      {info?.available && <iframe className="mapFrame" src={info.r2Path} title="Dynmap" />}
      {!info?.available && info?.previewDnsReady && info?.preview && (
        <iframe className="mapFrame" src={info.preview.url} title="Dynmap preview" />
      )}
      {!info?.available && !info?.preview && (
        <div className="mapEmpty">
          <Map size={30} />
          <strong>
            {info?.compatible === false
              ? 'Map provider unsupported'
              : info?.enabled === false
                ? 'Dynmap disabled'
                : info?.mirrored
                  ? 'Map tiles are rendering'
                  : 'No map tiles published yet'}
          </strong>
          <span>
            {info?.message
              ? info.message
              : info
              ? `Map mirror: ${info.r2Path}. Waiting for rendered world tiles.`
              : 'Map metadata is not available.'}
          </span>
          {info?.previewError && <small>{info.previewError}</small>}
          {renderError && <small>{renderError}</small>}
        </div>
      )}
    </section>
  );
}

function SettingsPanel({
  detail,
  onSave,
  onDelete
}: {
  detail: ServerDetail;
  onSave: (patch: ServerPatchRequest) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(() => settingsDraft(detail.manifest));
  const [deleteConfirm, setDeleteConfirm] = useState('');
  useEffect(() => setDraft(settingsDraft(detail.manifest)), [detail.manifest.serverId, detail.manifest.updatedAt]);
  useEffect(() => setDeleteConfirm(''), [detail.manifest.serverId]);

  return (
    <section className="settingsGrid">
      <Panel title="Identity" icon={<Server />}>
        <Field label="Server name">
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Invite prefix">
          <input value={draft.invitePrefix} onChange={(event) => setDraft({ ...draft, invitePrefix: event.target.value })} />
        </Field>
        <Field label="MOTD">
          <input value={draft.motd} onChange={(event) => setDraft({ ...draft, motd: event.target.value })} />
        </Field>
        <Field label="Version">
          <input value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} />
        </Field>
      </Panel>
      <Panel title="World rules" icon={<Gamepad2 />}>
        <Field label="Game mode">
          <select
            value={draft.gameMode}
            onChange={(event) =>
              setDraft({
                ...draft,
                gameMode: event.target.value as MinecraftServerManifest['gameMode']
              })
            }
          >
            <option value="survival">Survival</option>
            <option value="creative">Creative</option>
            <option value="adventure">Adventure</option>
            <option value="spectator">Spectator</option>
          </select>
        </Field>
        <Field label="Difficulty">
          <select
            value={draft.difficulty}
            onChange={(event) =>
              setDraft({
                ...draft,
                difficulty: event.target.value as MinecraftServerManifest['difficulty']
              })
            }
          >
            <option value="peaceful">Peaceful</option>
            <option value="easy">Easy</option>
            <option value="normal">Normal</option>
            <option value="hard">Hard</option>
          </select>
        </Field>
        <Toggle label="PVP" checked={draft.pvp} onChange={(pvp) => setDraft({ ...draft, pvp })} />
        <Toggle label="Allow Nether" checked={draft.allowNether} onChange={(allowNether) => setDraft({ ...draft, allowNether })} />
        <Toggle label="Command blocks" checked={draft.enableCommandBlock} onChange={(enableCommandBlock) => setDraft({ ...draft, enableCommandBlock })} />
      </Panel>
      <Panel title="Capacity" icon={<Cpu />}>
        <Field label="Max players">
          <input type="number" value={draft.maxPlayers} onChange={(event) => setDraft({ ...draft, maxPlayers: Number(event.target.value) })} />
        </Field>
        <Field label="View distance">
          <input type="number" value={draft.viewDistance} onChange={(event) => setDraft({ ...draft, viewDistance: Number(event.target.value) })} />
        </Field>
        <Field label="Simulation distance">
          <input type="number" value={draft.simulationDistance} onChange={(event) => setDraft({ ...draft, simulationDistance: Number(event.target.value) })} />
        </Field>
        <div className="splitInputs">
          <Field label="Memory min">
            <input value={draft.memoryMin} onChange={(event) => setDraft({ ...draft, memoryMin: event.target.value })} />
          </Field>
          <Field label="Memory max">
            <input value={draft.memoryMax} onChange={(event) => setDraft({ ...draft, memoryMax: event.target.value })} />
          </Field>
        </div>
      </Panel>
      <Panel title="Access lists" icon={<ListChecks />}>
        <Toggle label="Whitelist" checked={draft.whitelist} onChange={(whitelist) => setDraft({ ...draft, whitelist })} />
        <Field label="Operators, comma separated">
          <input value={draft.opsText} onChange={(event) => setDraft({ ...draft, opsText: event.target.value })} />
        </Field>
        <Field label="Allowed players, comma separated">
          <input value={draft.whitelistText} onChange={(event) => setDraft({ ...draft, whitelistText: event.target.value })} />
        </Field>
      </Panel>
      <div className="settingsFooter">
        <button className="iconTextButton primary" onClick={() => onSave(draftToPatch(draft))}>
          <Save size={16} /> Save server settings
        </button>
        <button className="iconTextButton" onClick={() => onSave({ invite: { rotate: true } })}>
          <RefreshCcw size={16} /> Regenerate invite code
        </button>
      </div>
      <Panel title="Delete server" icon={<AlertTriangle />}>
        <div className="dangerZone">
          <p className="fieldHint">
            Permanently delete this server, retained backups, and its sandbox state. Type the server name to confirm.
          </p>
          <Field label={`Type "${detail.summary.name}"`}>
            <input
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              placeholder={detail.summary.name}
            />
          </Field>
          <button
            className="iconTextButton danger"
            disabled={deleteConfirm !== detail.summary.name}
            onClick={onDelete}
          >
            <Trash2 size={16} /> Delete server
          </button>
        </div>
      </Panel>
    </section>
  );
}

function CreateServerDialog({
  presets,
  busy,
  onClose,
  onCreate
}: {
  presets: PresetsResponse | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (payload: ServerCreateRequest) => Promise<void>;
}) {
  const [name, setName] = useState('Survival world');
  const [invitePrefix, setInvitePrefix] = useState('Survival world');
  const [preset, setPreset] = useState<ServerPresetOption>('paper');
  const [version, setVersion] = useState(FALLBACK_VERSION_OPTIONS[0].version);
  const [versionTouched, setVersionTouched] = useState(false);
  const [location, setLocation] = useState<MinecraftLocationPreference>('auto');
  const [seed, setSeed] = useState('');
  const [motd, setMotd] = useState('Cubeflare Minecraft server');
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [difficulty, setDifficulty] = useState('normal');
  const [gameMode, setGameMode] = useState('survival');
  const [viewDistance, setViewDistance] = useState(DEFAULT_VIEW_DISTANCE);
  const [simulationDistance, setSimulationDistance] = useState(DEFAULT_SIMULATION_DISTANCE);
  const [pvp, setPvp] = useState(true);
  const [whitelist, setWhitelist] = useState(false);
  const [enableCommandBlock, setEnableCommandBlock] = useState(false);
  const [allowNether, setAllowNether] = useState(true);
  const [ops, setOps] = useState('');
  const [whitelistPlayers, setWhitelistPlayers] = useState('');
  const [setupScript, setSetupScript] = useState('');
  const [propertiesJson, setPropertiesJson] = useState('{\n  "spawn-protection": 16\n}');
  const [parseError, setParseError] = useState('');
  const versionListId = `mcVersions-${preset}`;
  const versionOptions = useMemo(() => {
    if (preset === 'custom') return presets?.versions?.vanilla ?? presets?.paperVersions ?? FALLBACK_VERSION_OPTIONS;
    return presets?.versions?.[preset] ?? (preset === 'paper' ? presets?.paperVersions : undefined) ?? FALLBACK_VERSION_OPTIONS;
  }, [preset, presets]);
  const selectedVersion = versionOptions.find((item) => item.version === version);

  useEffect(() => {
    if (preset === 'custom') return;
    const defaultVersion =
      presets?.defaultVersions?.[preset] ??
      versionOptions.find((item) => item.channel === 'latest release')?.version ??
      versionOptions.find((item) => item.channel === 'latest')?.version ??
      versionOptions[0]?.version;
    if (!defaultVersion) return;
    if (!versionTouched || !versionOptions.some((item) => item.version === version)) {
      setVersion(defaultVersion);
    }
  }, [preset, presets?.defaultVersions, version, versionOptions, versionTouched]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setParseError('');
    let serverProperties: Record<string, string | number | boolean> = {};
    try {
      serverProperties = propertiesJson.trim() ? JSON.parse(propertiesJson) : {};
    } catch {
      setParseError('server.properties overrides must be valid JSON');
      return;
    }

    await onCreate({
      name,
      invitePrefix,
      preset: preset as ServerCreateRequest['preset'],
      version,
      location,
      seed,
      motd,
      maxPlayers,
      difficulty: difficulty as ServerCreateRequest['difficulty'],
      gameMode: gameMode as ServerCreateRequest['gameMode'],
      viewDistance,
      simulationDistance,
      pvp,
      whitelist,
      enableCommandBlock,
      allowNether,
      ops: splitCsv(ops),
      whitelistPlayers: splitCsv(whitelistPlayers),
      setupScript,
      serverProperties
    });
  }

  return (
    <div className="modalBackdrop" role="presentation">
      <form className="createDialog" onSubmit={submit}>
        <div className="dialogHeader">
          <div>
            <p className="eyebrow">New server</p>
            <h2>Configure a Minecraft server</h2>
          </div>
          <button className="iconButton" type="button" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="createSections">
          <Panel title="Core" icon={<Layers />}>
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value;
                  setName(nextName);
                  if (invitePrefix === name) setInvitePrefix(nextName);
                }}
              />
            </Field>
            <Field label="Invite prefix">
              <input value={invitePrefix} onChange={(event) => setInvitePrefix(event.target.value)} />
              <span className="fieldHint">Used in the persistent bridge command your friends run.</span>
            </Field>
            <div className="splitInputs">
              <Field label="Preset">
                <select
                  value={preset}
                  onChange={(event) => {
                    setPreset(event.target.value as ServerPresetOption);
                    setVersionTouched(false);
                  }}
                >
                  {(presets?.presets ?? ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'custom']).map((item) => (
                    <option value={item} key={item}>
                      {capitalize(item)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Version">
                <input
                  list={versionListId}
                  value={version}
                  onChange={(event) => {
                    setVersionTouched(true);
                    setVersion(event.target.value);
                  }}
                />
                <datalist id={versionListId}>
                  {versionOptions.map((item) => (
                    <option value={item.version} key={item.version} label={versionOptionLabel(item)} />
                  ))}
                </datalist>
                <span className="fieldHint">
                  {versionOptions.length} versions available
                  {selectedVersion ? ` - ${selectedVersion.channel}` : ''}
                </span>
              </Field>
            </div>
            <Field label="MOTD">
              <input value={motd} onChange={(event) => setMotd(event.target.value)} />
            </Field>
            <Field label="Location">
              <select
                value={location}
                onChange={(event) => setLocation(event.target.value as MinecraftLocationPreference)}
              >
                {MINECRAFT_LOCATION_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="fieldHint">
                Best-effort Cloudflare placement hint used when this server is first created.
              </span>
            </Field>
          </Panel>

          <Panel title="World" icon={<Gamepad2 />}>
            <Field label="Seed">
              <input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Blank for random" />
            </Field>
            <div className="splitInputs">
              <Field label="Game mode">
                <select value={gameMode} onChange={(event) => setGameMode(event.target.value)}>
                  <option value="survival">Survival</option>
                  <option value="creative">Creative</option>
                  <option value="adventure">Adventure</option>
                  <option value="spectator">Spectator</option>
                </select>
              </Field>
              <Field label="Difficulty">
                <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
                  <option value="peaceful">Peaceful</option>
                  <option value="easy">Easy</option>
                  <option value="normal">Normal</option>
                  <option value="hard">Hard</option>
                </select>
              </Field>
            </div>
            <div className="toggleGrid">
              <Toggle label="PVP" checked={pvp} onChange={setPvp} />
              <Toggle label="Whitelist" checked={whitelist} onChange={setWhitelist} />
              <Toggle label="Command blocks" checked={enableCommandBlock} onChange={setEnableCommandBlock} />
              <Toggle label="Nether" checked={allowNether} onChange={setAllowNether} />
            </div>
          </Panel>

          <Panel title="Capacity" icon={<Cpu />}>
            <Field label="Max players">
              <input type="number" value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))} />
            </Field>
            <div className="splitInputs">
              <Field label="View distance">
                <input type="number" value={viewDistance} onChange={(event) => setViewDistance(Number(event.target.value))} />
              </Field>
              <Field label="Simulation">
                <input type="number" value={simulationDistance} onChange={(event) => setSimulationDistance(Number(event.target.value))} />
              </Field>
            </div>
            <p className="fieldHint">
              Servers default to Cloudflare's standard-4 container tier with a fixed {DEFAULT_MEMORY_MAX} JVM heap, view distance {DEFAULT_VIEW_DISTANCE}, and simulation distance {DEFAULT_SIMULATION_DISTANCE}.
            </p>
          </Panel>

          <Panel title="Access and automation" icon={<SlidersHorizontal />}>
            <Field label="Operators">
              <input value={ops} onChange={(event) => setOps(event.target.value)} placeholder="Comma separated usernames" />
            </Field>
            <Field label="Whitelist players">
              <input value={whitelistPlayers} onChange={(event) => setWhitelistPlayers(event.target.value)} placeholder="Comma separated usernames" />
            </Field>
            <Field label="Setup script">
              <textarea value={setupScript} onChange={(event) => setSetupScript(event.target.value)} />
            </Field>
            <Field label="server.properties overrides">
              <textarea value={propertiesJson} onChange={(event) => setPropertiesJson(event.target.value)} />
            </Field>
          </Panel>
        </div>

        {parseError && <div className="errorBanner compact">{parseError}</div>}
        <div className="dialogFooter">
          <button className="iconTextButton subtle" type="button" onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy} className="iconTextButton primary" type="submit">
            <Server size={16} /> Create server
          </button>
        </div>
      </form>
    </div>
  );
}

function ServerCard({
  server,
  active,
  busy,
  onSelect,
  onStart,
  onBackup
}: {
  server: ServerSummary;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onStart: () => void;
  onBackup: () => void;
}) {
  return (
    <article className={`serverCard ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className="serverCardTop">
        <StatusPill status={server.status} />
        <span>{server.preset}</span>
      </div>
      <h2>{server.name}</h2>
      <p>{serverConnectionSubtitle(server)}</p>
      <div className="serverCardMeta">
        <span>
            <Users size={14} /> {server.activeBridgeConnections ?? 0} bridge
        </span>
        <span>
          <DatabaseBackup size={14} /> {formatTime(server.lastBackupAt)}
        </span>
      </div>
      <div className="cardActions">
        <button
          disabled={busy}
          className="iconTextButton primary"
          onClick={(event) => {
            event.stopPropagation();
            onStart();
          }}
        >
          <Power size={15} /> Wake
        </button>
        <button
          disabled={busy}
          className="iconButton"
          title="Backup"
          onClick={(event) => {
            event.stopPropagation();
            onBackup();
          }}
        >
          <DatabaseBackup size={16} />
        </button>
      </div>
    </article>
  );
}

function DashboardWelcome({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="dashboardWelcome">
      <div className="welcomeScene" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="eyebrow">Fleet console</p>
      <h1>Build your first persistent world</h1>
      <p>
        Create a server, start it, watch the readiness events, and manage backups, files,
        terminal, RCON, plugins, and map output from one cockpit.
      </p>
      <button className="iconTextButton primary" onClick={onCreate}>
        <Plus size={17} /> Create server
      </button>
    </div>
  );
}

function FleetEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="fleetEmpty">
      <Server size={26} />
      <strong>No servers yet</strong>
      <span>Create your first server with a preset or custom setup script.</span>
      <button className="iconTextButton primary" onClick={onCreate}>
        <Plus size={16} /> New server
      </button>
    </div>
  );
}

function BrandLockup({ subtitle }: { subtitle: string }) {
  return (
    <div className="brand">
      <div className="brandMark" aria-hidden="true" />
      <div>
        <strong>Cubeflare</strong>
        <span>{subtitle}</span>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="miniStat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Signal({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="signal">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
  className = ''
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      <header>
        {icon}
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggleField">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SpecList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="specList">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusPill({ status }: { status: string }) {
  const Icon = status === 'running' ? CheckCircle2 : status === 'error' ? AlertTriangle : Clock;
  return (
    <span className={`statusPill ${status}`}>
      <Icon size={13} />
      {status}
    </span>
  );
}

function ErrorBanner({ message, detail }: { message: string; detail?: unknown }) {
  const diagnostics = parseLifecycleDiagnostics(detail);
  return (
    <div className="errorBanner">
      <strong>{message}</strong>
      {diagnostics && (
        <details>
          <summary>Show diagnostics</summary>
          {diagnostics.events.length > 0 && (
            <ul>
              {diagnostics.events.slice(0, 6).map((event) => (
                <li key={`${event.type}-${event.createdAt}`}>
                  <span>{event.type}</span>
                  <time>{formatTime(event.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
          {(diagnostics.logs.stdoutTail || diagnostics.logs.stderrTail) && (
            <pre>{[diagnostics.logs.stderrTail, diagnostics.logs.stdoutTail].filter(Boolean).join('\n')}</pre>
          )}
        </details>
      )}
    </div>
  );
}

function EmptyPanel({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="emptyPanel">
      {icon}
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function parseSseData<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(String(event.data)) as T;
  } catch {
    return null;
  }
}

type LifecycleDiagnostics = {
  events: Array<{ type: string; createdAt: string }>;
  logs: { stdoutTail?: string; stderrTail?: string };
};

function parseLifecycleDiagnostics(detail: unknown): LifecycleDiagnostics | null {
  if (!isRecord(detail)) return null;
  const events = Array.isArray(detail.events)
    ? detail.events
        .filter(isRecord)
        .map((event) => ({
          type: typeof event.type === 'string' ? event.type : 'event',
          createdAt: typeof event.createdAt === 'string' ? event.createdAt : ''
        }))
    : [];
  const logs = isRecord(detail.logs)
    ? {
        stdoutTail: typeof detail.logs.stdoutTail === 'string' ? detail.logs.stdoutTail : '',
        stderrTail: typeof detail.logs.stderrTail === 'string' ? detail.logs.stderrTail : ''
      }
    : { stdoutTail: '', stderrTail: '' };
  return events.length || logs.stdoutTail || logs.stderrTail ? { events, logs } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function joinStatusText(detail: ServerDetail, runtime: MinecraftRuntimeStatus | null): string {
  if (runtime?.process !== 'running') {
    return 'Set up a secure bridge. The CLI wakes this world, restores the latest backup, and prints the local Minecraft address to join.';
  }
  if (!runtime.rconHealthy) {
    return 'Set up a secure bridge. The server is running, and the CLI will wait until control access is ready.';
  }
  return 'Set up a secure bridge. The CLI chooses an available local port and prints the Minecraft address to join.';
}

function appendLogLine(setLogs: (updater: (current: string) => string) => void, line: string) {
  setLogs((current) => (current ? `${current}\n${line}` : line));
}

const SERVER_ROOT = '/workspace/server';

function normalizeServerPath(value: string): string {
  if (!value || value === '.' || value === SERVER_ROOT) return '';
  const withoutRoot = value.startsWith(`${SERVER_ROOT}/`) ? value.slice(SERVER_ROOT.length + 1) : value;
  return withoutRoot.replace(/^\/+/, '').replace(/\/+/g, '/');
}

function joinServerPath(base: string, segment: string): string {
  const cleanBase = normalizeServerPath(base);
  const cleanSegment = segment.trim().replace(/^\/+/, '').replace(/\/+/g, '/');
  return [cleanBase, cleanSegment].filter(Boolean).join('/');
}

function parentServerPath(path: string): string {
  const parts = normalizeServerPath(path).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function pathBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = normalizeServerPath(path).split('/').filter(Boolean);
  const crumbs = [{ label: 'server', path: '' }];
  let current = '';
  for (const part of parts) {
    current = joinServerPath(current, part);
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function isEditableFile(file: FileEntry): boolean {
  if (file.type !== 'file' || file.size > 1_000_000) return false;
  const lower = file.name.toLowerCase();
  const textNames = new Set(['server.properties', 'eula.txt', 'ops.json', 'whitelist.json']);
  const textExtensions = [
    '.txt',
    '.properties',
    '.json',
    '.yml',
    '.yaml',
    '.toml',
    '.cfg',
    '.conf',
    '.log',
    '.md',
    '.sh',
    '.mcfunction'
  ];
  return textNames.has(lower) || textExtensions.some((extension) => lower.endsWith(extension));
}

function formatBytes(bytes?: number): string {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function settingsDraft(manifest: MinecraftServerManifest) {
  return {
    name: manifest.name,
    invitePrefix: manifest.invite?.prefix ?? manifest.name,
    motd: manifest.motd,
    version: manifest.version,
    gameMode: manifest.gameMode,
    difficulty: manifest.difficulty,
    pvp: manifest.pvp,
    allowNether: manifest.allowNether,
    enableCommandBlock: manifest.enableCommandBlock,
    maxPlayers: manifest.maxPlayers,
    viewDistance: manifest.viewDistance,
    simulationDistance: manifest.simulationDistance,
    memoryMin: manifest.memoryMin,
    memoryMax: manifest.memoryMax,
    whitelist: manifest.whitelist,
    opsText: manifest.ops.join(', '),
    whitelistText: manifest.whitelistPlayers.join(', ')
  };
}

function draftToPatch(draft: ReturnType<typeof settingsDraft>): ServerPatchRequest {
  return {
    name: draft.name,
    invite: { prefix: draft.invitePrefix },
    motd: draft.motd,
    version: draft.version,
    gameMode: draft.gameMode as MinecraftServerManifest['gameMode'],
    difficulty: draft.difficulty as MinecraftServerManifest['difficulty'],
    pvp: draft.pvp,
    allowNether: draft.allowNether,
    enableCommandBlock: draft.enableCommandBlock,
    maxPlayers: draft.maxPlayers,
    viewDistance: draft.viewDistance,
    simulationDistance: draft.simulationDistance,
    memoryMin: draft.memoryMin,
    memoryMax: draft.memoryMax,
    whitelist: draft.whitelist,
    ops: splitCsv(draft.opsText),
    whitelistPlayers: splitCsv(draft.whitelistText)
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function serverConnectionSubtitle(server: ServerSummary): string {
  if (server.status === 'running') return 'CLI bridge available';
  if (server.status === 'starting') return 'Preparing CLI bridge';
  if (server.status === 'stopping') return 'Bridge shutting down';
  return 'Starts through CLI bridge';
}

function versionOptionLabel(item: VersionOption): string {
  const parts = [item.channel];
  if (item.releasedAt) {
    const date = new Date(item.releasedAt);
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString());
  }
  return parts.filter(Boolean).join(' - ');
}

function shortLocationLabel(
  observation: RuntimeLocation | undefined,
  preference: MinecraftLocationPreference | undefined
): string {
  if (observation?.colo) return observation.country ? `${observation.colo} / ${observation.country}` : observation.colo;
  if (observation?.region) return observation.country ? `${observation.region} / ${observation.country}` : observation.region;
  return minecraftLocationLabel(preference);
}

function fullLocationLabel(observation: RuntimeLocation | undefined): string {
  if (!observation) return 'not observed yet';
  const place = [observation.colo, observation.region, observation.country].filter(Boolean).join(' / ');
  return place || 'observed';
}

function formatCompactTime(value?: string): string {
  if (!value) return 'none';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}

function formatDuration(ms?: number): string {
  const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatTime(value?: string): string {
  if (!value) return 'none';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
