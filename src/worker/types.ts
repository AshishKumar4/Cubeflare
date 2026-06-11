import type { DirectoryBackup } from '@cloudflare/sandbox';
import type { IdentityRegistryDO } from './durable/identity';
import type { UserDO } from './durable/user';
import type { MinecraftSandbox } from './sandbox/MinecraftSandbox';
import type { MinecraftLocationPreference } from '../shared/minecraft-locations';
import type { MinecraftJavaConfig } from '../shared/minecraft-optimization';

export type AppEnv = {
  ASSETS: Fetcher;
  BACKUP_BUCKET: R2Bucket;
  DYNMAP_BUCKET: R2Bucket;
  PLUGIN_BUCKET: R2Bucket;
  IDENTITY_REGISTRY: DurableObjectNamespace<IdentityRegistryDO>;
  USER_DO: DurableObjectNamespace<UserDO>;
  MINECRAFT_SANDBOX: DurableObjectNamespace<MinecraftSandbox>;
  CUBEFLARE_SECRET?: string;
  PUBLIC_BASE_HOST?: string;
  PREVIEW_HOSTNAME?: string;
  PREVIEW_DNS_READY?: string;
  SANDBOX_TRANSPORT?: 'http' | 'websocket' | 'rpc';
  BACKUP_INTERVAL_SECONDS?: string;
  MAX_BACKUPS_PER_SERVER?: string;
  MC_SLEEP_AFTER?: string;
  CONNECTOR_ACTIVITY_TTL_SECONDS?: string;
  MC_DEFAULT_MEMORY_MIN?: string;
  MC_DEFAULT_MEMORY_MAX?: string;
  MC_DEFAULT_VERSION?: string;
  DYNMAP_INITIAL_RENDER_RADIUS?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  BACKUP_BUCKET_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

export type AppVariables = {
  user: AuthenticatedUser;
};

export type HonoBindings = {
  Bindings: AppEnv;
  Variables: AppVariables;
};

export type AuthenticatedUser = {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonRecord = Record<string, JsonValue>;

export type ServerPreset =
  | 'vanilla'
  | 'paper'
  | 'purpur'
  | 'folia'
  | 'fabric'
  | 'custom';

export type NetworkMode = 'bridge';

export type PluginSource =
  | { type: 'builtin'; id: string }
  | { type: 'url'; url: string; filename?: string }
  | { type: 'r2'; key: string; filename: string };

export type PluginConfig = {
  id: string;
  label: string;
  enabled: boolean;
  source: PluginSource;
  filename: string;
  notes?: string;
};

export type RuntimeLocationObservation = {
  colo?: string;
  region?: string;
  country?: string;
  source: 'worker-request';
  observedAt: string;
};

export type MinecraftServerManifest = {
  serverId: string;
  ownerId: string;
  name: string;
  preset: ServerPreset;
  version: string;
  seed?: string;
  memoryMin: string;
  memoryMax: string;
  java: MinecraftJavaConfig;
  rconPassword: string;
  onlineMode: boolean;
  motd: string;
  maxPlayers: number;
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
  gameMode: 'survival' | 'creative' | 'adventure' | 'spectator';
  enableCommandBlock: boolean;
  allowNether: boolean;
  viewDistance: number;
  simulationDistance: number;
  pvp: boolean;
  whitelist: boolean;
  ops: string[];
  whitelistPlayers: string[];
  plugins: PluginConfig[];
  modpack?: {
    loader?: 'fabric' | 'forge' | 'quilt';
    installerUrl?: string;
    mods?: PluginSource[];
  };
  setupScript?: string;
  serverProperties: Record<string, string | number | boolean>;
  network: {
    mode: NetworkMode;
    publicBaseHost?: string;
    joinHost?: string;
  };
  invite: {
    prefix: string;
    rotation: string;
    updatedAt: string;
  };
  location: {
    preference: MinecraftLocationPreference;
    actual?: RuntimeLocationObservation;
  };
  dynmap: {
    enabled: boolean;
    publicPathPrefix: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type BackupRecord = {
  id: string;
  backup: DirectoryBackup;
  serverId: string;
  reason: string;
  createdAt: string;
  sizeBytes?: number;
  status: 'ready' | 'failed';
};

export type ServerLifecycleStep = {
  key: string;
  label: string;
  status: 'ok' | 'error';
  durationMs: number;
  completedAt: string;
  detail?: string;
  reason?: string;
  backupId?: string;
  message?: string;
};

export type ServerLifecyclePhase = {
  key: string;
  label: string;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  detail?: string;
  reason?: string;
  backupId?: string;
  lastCompletedStep?: ServerLifecycleStep;
};

export type ServerSummary = {
  id: string;
  ownerId: string;
  name: string;
  preset: ServerPreset;
  version: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'deleting' | 'error';
  playersOnline: number;
  activeBridgeConnections: number;
  maxPlayers: number;
  lastBackupAt?: string;
  joinHost: string;
  dynmapEnabled: boolean;
  locationPreference: MinecraftLocationPreference;
  runtimeLocation?: RuntimeLocationObservation;
  lifecycle?: ServerLifecyclePhase;
  createdAt: string;
  updatedAt: string;
};

export type MinecraftRuntimeStatus = {
  process: 'missing' | 'running' | 'exited' | 'error';
  containerRunning: boolean;
  playersOnline: number;
  activeBridgeConnections: number;
  maxPlayers: number;
  players: string[];
  motd?: string;
  version?: string;
  lastBackupAt?: string;
  joinHost?: string;
  location?: RuntimeLocationObservation;
  rconHealthy: boolean;
};

export type ServerEventRecord = {
  type: string;
  detail: string;
  createdAt: string;
};

export type ServerControlSnapshot = {
  summary: ServerSummary;
  manifest: MinecraftServerManifest;
  runtime: MinecraftRuntimeStatus | null;
  backups: BackupRecord[];
  events: ServerEventRecord[];
  updatedAt: string;
};

export type ServerCreateRequest = Partial<
  Pick<
    MinecraftServerManifest,
    | 'name'
    | 'preset'
    | 'version'
    | 'seed'
    | 'motd'
    | 'maxPlayers'
    | 'difficulty'
    | 'gameMode'
    | 'enableCommandBlock'
    | 'allowNether'
    | 'viewDistance'
    | 'simulationDistance'
    | 'pvp'
    | 'whitelist'
    | 'ops'
    | 'whitelistPlayers'
    | 'plugins'
    | 'setupScript'
    | 'serverProperties'
  >
> & {
  location?: MinecraftLocationPreference;
  invitePrefix?: string;
};

export type ServerPatchRequest = Partial<ServerCreateRequest> & {
  network?: Partial<MinecraftServerManifest['network']>;
  dynmap?: Partial<MinecraftServerManifest['dynmap']>;
  invite?: {
    prefix?: string;
    rotate?: boolean;
  };
  memoryMin?: string;
  memoryMax?: string;
};

export type BridgeTokenPayload = {
  v: 1;
  aud: 'cubeflare-bridge';
  serverId: string;
  exp: number;
  nonce: string;
};

export type ConnectorActivityTokenPayload = {
  v: 1;
  aud: 'cubeflare-cli-connect-activity';
  serverId: string;
  host: string;
  sessionId: string;
  exp: number;
  nonce: string;
};

export type CliTokenPayload = {
  v: 1;
  aud: 'cubeflare-cli';
  userId: string;
  exp: number;
  nonce: string;
};

export type ConnectorInviteResponse = {
  serverId: string;
  host: string;
  inviteCode: string;
  expiresAt: string | null;
  localAddress: string;
  installCommand: string;
  command: string;
};

export type ConnectorSessionRequest = {
  inviteCode: string;
  server?: string;
};

export type ConnectorActivityRequest = {
  token: string;
  activeConnections: number;
};

export type ConnectorSessionResponse = {
  serverId: string;
  host: string;
  bridgeUrl: string;
  bridgeToken: string;
  activityToken: string;
  activityExpiresAt: string;
  expiresAt: string;
  expiresInSeconds: number;
  localAddress: string;
  requestId: string;
};

export type ConnectorDiagnosticsResponse = {
  serverId: string;
  host: string;
  summary: ServerSummary | null;
  runtime: MinecraftRuntimeStatus | null;
  lifecycle: ServerLifecyclePhase | null;
  events: ServerEventRecord[];
};

export type ConnectorProgressResponse = {
  serverId: string;
  host: string;
  summary: ServerSummary | null;
  runtime: MinecraftRuntimeStatus | null;
  lifecycle: ServerLifecyclePhase | null;
  events: ServerEventRecord[];
};

export type CliAuthStartResponse = {
  deviceToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
};

export type CliAuthPollResponse =
  | { status: 'pending'; expiresAt: string; intervalSeconds: number }
  | { status: 'expired'; message: string }
  | {
      status: 'approved';
      token: string;
      expiresAt: string;
      origin: string;
      user: Pick<AuthenticatedUser, 'userId' | 'email' | 'displayName'>;
    };

export type CliServerListResponse = {
  servers: ServerSummary[];
};
