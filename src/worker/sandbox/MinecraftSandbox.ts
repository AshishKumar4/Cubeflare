import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { DirectoryBackup, Process } from "@cloudflare/sandbox";
import { parsePositiveInt } from "../http";
import {
  MINECRAFT_SERVER_DIR,
  minecraftBackupExcludes,
} from "../minecraft/backup-policy";
import {
  planLifecycleAlarm,
  shouldRenewContainerActivity,
} from "../minecraft/lifecycle-policy";
import { statusFromRuntime } from "../minecraft/runtime-state";
import { executeRcon, parseListResponse } from "../minecraft/rcon";
import { internalBaseUrlForManifest, publicJoinHost } from "../hosts";
import {
  normalizeManifestCompatibility,
  patchManifest,
} from "../minecraft/presets";
import {
  summarizeConnectorActivitySessions,
  updateConnectorActivitySessions,
  type ConnectorActivitySessions,
  type ConnectorActivitySnapshot,
} from "../minecraft/connector-activity";
import { normalizeMinecraftMemory } from "../../shared/minecraft-optimization";
import { dynmapSyncSecret, minecraftBridgeSecret } from "../secrets";
import type {
  AppEnv,
  BackupRecord,
  MinecraftRuntimeStatus,
  MinecraftServerManifest,
  RuntimeLocationObservation,
  ServerControlSnapshot,
  ServerEventRecord,
  ServerPatchRequest,
  ServerLifecyclePhase,
  ServerLifecycleStep,
  ServerSummary,
} from "../types";

const SERVER_DIR = MINECRAFT_SERVER_DIR;
const MANIFEST_PATH = `${SERVER_DIR}/.cubeflare/manifest.json`;
const MINECRAFT_PROCESS = "minecraft-server";
const BRIDGE_PROCESS = "minecraft-bridge";
const DYNMAP_SYNC_PROCESS = "dynmap-sync";
const MANAGED_PROCESS_IDS = [
  MINECRAFT_PROCESS,
  BRIDGE_PROCESS,
  DYNMAP_SYNC_PROCESS,
] as const;
const MINECRAFT_PORT = 25565;
const RCON_PORT = 25575;
const BRIDGE_PORT = 25566;
const DYNMAP_PORT = 8123;
const PROCESS_STOP_GRACE_MS = 20_000;
const PROCESS_KILL_WAIT_MS = 10_000;
const PROCESS_STOP_POLL_MS = 500;
const CONNECTOR_ACTIVITY_SESSIONS_KEY = "connectorActivitySessions";
const LIFECYCLE_TICK_SCHEDULED_AT_KEY = "lifecycleTickScheduledAt";
const LIFECYCLE_PHASE_KEY = "lifecyclePhase";
const RUNTIME_CACHE_KEY = "runtime";
const DELETING_KEY = "deleting";
const DYNMAP_INITIAL_RENDER_KEY = "dynmapInitialRenderSignature";
const DYNMAP_DEFAULT_INITIAL_RENDER_RADIUS = 2048;

type TcpPort = {
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
};

type ContainerStateWithTcp = DurableObjectState & {
  container?: {
    running?: boolean;
    getTcpPort(port: number): TcpPort;
  };
};

type StateRow = {
  key: string;
  value: string;
};

type BackupRow = {
  id: string;
  json: string;
  created_at: string;
};

type EventRow = {
  id: number;
  type: string;
  detail_json: string;
  created_at: string;
};

type StartOptions = {
  waitForMinecraft: boolean;
};

type ConnectorActivityInput = {
  sessionId: string;
  activeBridgeConnections: number;
};

type PresenceMetrics = {
  playersOnline: number;
  activeBridgeConnections: number;
};

export class MinecraftSandbox extends BaseSandbox<AppEnv> {
  defaultPort = 3000;
  sleepAfter: string | number = "30m";

  private bootPromise: Promise<MinecraftRuntimeStatus> | null = null;
  private backupQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState<{}>, env: AppEnv) {
    super(ctx, env);
    const configuredSleep = env.MC_SLEEP_AFTER;
    if (configuredSleep) {
      this.sleepAfter = configuredSleep;
    }

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS backups (
          id TEXT PRIMARY KEY,
          json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    await this.setKeepAlive(false);

    const manifest = this.getManifest();
    if (!manifest) return;
    if (this.isDeleting()) return;
    const status = this.getStatusValue();
    if (status !== "starting" && status !== "running") return;
    this.setLifecyclePhase("container_onstart", {
      reason: "container-onstart",
      detail:
        "Container provisioned; restoring saved state before launching Minecraft",
    });
    await this.scheduleLifecycleTick();
    if (this.bootPromise) return;

    await this.bootMinecraft("container-onstart", { waitForMinecraft: false });
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    if (this.isDeleting()) return;
    const manifest = this.getManifest();
    if (manifest) {
      this.clearConnectorActivity();
      const runtime = this.offlineRuntime(manifest, "stopped");
      this.putJson(RUNTIME_CACHE_KEY, runtime);
      this.setStatusValue("stopped");
      this.setLifecyclePhase("stopped", {
        reason: "container-stopped",
        detail:
          "Container stopped; latest backup remains available for the next wake",
      });
      this.appendEvent("container.stopped", { serverId: manifest.serverId });
      const summary = this.summaryFromManifest(
        manifest,
        "stopped",
        emptyPresence(),
      );
      this.putJson("summary", summary);
      await this.syncUserSnapshot(summary);
    }
  }

  async create(manifest: MinecraftServerManifest): Promise<ServerSummary> {
    if (this.getManifest()) {
      throw new Error("Server already exists");
    }

    this.deleteString(DELETING_KEY);
    this.putJson("manifest", manifest);
    this.putString("status", "starting");
    this.setLifecyclePhase("starting", {
      reason: "server-created",
      detail: "Server record created; provisioning the sandbox",
    });
    this.appendEvent("server.created", { serverId: manifest.serverId });
    const summary = this.summaryFromManifest(
      manifest,
      "starting",
      emptyPresence(),
    );
    this.putJson("summary", summary);
    await this.syncUserSnapshot(summary);
    return summary;
  }

  getOwnerId(): string | null {
    return this.getManifest()?.ownerId ?? null;
  }

  getManifest(): MinecraftServerManifest | null {
    return this.getJson<MinecraftServerManifest>("manifest");
  }

  getSummary(): ServerSummary | null {
    const summary = this.getJson<ServerSummary>("summary");
    if (!summary) return null;
    return {
      ...summary,
      playersOnline: summary.playersOnline ?? 0,
      activeBridgeConnections: summary.activeBridgeConnections ?? 0,
      lifecycle: this.currentLifecyclePhase() ?? summary.lifecycle,
    };
  }

  async recordConnectorActivity(
    input: ConnectorActivityInput,
  ): Promise<ServerSummary | null> {
    if (this.isDeleting()) return null;
    const manifest = this.getManifest();
    if (!manifest) return null;

    const activity = updateConnectorActivitySessions(
      this.getConnectorActivitySessions(),
      {
        sessionId: input.sessionId,
        activeBridgeConnections: input.activeBridgeConnections,
        ttlSeconds: connectorActivityTtlSeconds(this.env),
        nowMs: Date.now(),
      },
    );
    this.putConnectorActivitySessions(activity.sessions);

    const current = this.getStatusValue();
    const status =
      this.containerState().container?.running === true || current === "error"
        ? current
        : "stopped";
    if (status !== current) {
      this.setStatusValue(status);
    }
    const summary = await this.publishSummary(manifest, status, {
      ...this.currentPresence(),
      activeBridgeConnections: activity.activeBridgeConnections,
    });
    if (
      activity.activeBridgeConnections > 0 &&
      (status === "running" || status === "starting")
    ) {
      await this.scheduleLifecycleTick();
    }
    return summary;
  }

  async recordLocationObservation(
    location: RuntimeLocationObservation,
  ): Promise<ServerSummary | null> {
    if (this.isDeleting()) return null;
    const manifest = this.getManifest();
    if (!manifest) return null;
    if (sameLocationObservation(manifest.location?.actual, location)) {
      return this.getSummary();
    }

    const next: MinecraftServerManifest = {
      ...manifest,
      location: {
        preference: manifest.location?.preference ?? "auto",
        actual: location,
      },
    };
    this.putJson("manifest", next);
    return this.publishSummary(
      next,
      this.getStatusValue(),
      this.currentPresence(),
    );
  }

  async patch(input: ServerPatchRequest): Promise<ServerSummary> {
    this.assertNotDeleting();
    const manifest = this.normalizedRuntimeManifest(this.requireManifest());
    const status = this.getStatusValue();
    if ((input.version || input.preset) && status !== "stopped") {
      throw new Error(
        "Version and preset changes require the server to be stopped first",
      );
    }

    const next = patchManifest(manifest, input);
    this.putJson("manifest", next);
    this.appendEvent("server.updated", {
      serverId: manifest.serverId,
      patch: Object.keys(input),
    });
    return this.publishSummary(next, status, this.currentPresence());
  }

  async startServer(
    reason = "manual-start",
  ): Promise<{ summary: ServerSummary; runtime: MinecraftRuntimeStatus }> {
    this.assertNotDeleting();
    const manifest = this.normalizedRuntimeManifest(this.requireManifest());
    const previous = this.getStatusValue();
    const cached =
      previous === "running" ? await this.readyCachedRuntime(manifest) : null;
    if (previous === "running" && cached) {
      const summary = await this.syncRuntimeSummary(
        manifest,
        "running",
        cached,
      );
      await this.scheduleLifecycleTick();
      return { summary, runtime: cached };
    }

    if (previous !== "running") {
      this.setStatusValue("starting");
      this.setLifecyclePhase("starting", {
        reason,
        detail: "Preparing sandbox and Minecraft runtime",
      });
      this.appendEvent("server.starting", { reason });
      await this.publishSummary(manifest, "starting", this.currentPresence());
    }

    try {
      const runtime = await this.bootMinecraft(reason, {
        waitForMinecraft: true,
      });
      this.setLifecyclePhase("ready", {
        reason,
        detail: "Minecraft is accepting connections",
      });
      const summary = await this.syncRuntimeSummary(
        this.requireManifest(),
        "running",
        runtime,
      );
      await this.scheduleLifecycleTick();
      return { summary, runtime };
    } catch (error) {
      await this.markLifecycleError(manifest, "server.start_failed", error);
      throw error;
    }
  }

  async stopServer(
    reason = "manual-stop",
  ): Promise<{ summary: ServerSummary; backup: BackupRecord | null }> {
    this.assertNotDeleting();
    const manifest = this.requireManifest();
    const current = this.getStatusValue();
    if (current === "stopped") {
      await this.destroyStoppedContainer();
      const summary = this.summaryFromManifest(
        manifest,
        "stopped",
        emptyPresence(),
      );
      this.putJson(RUNTIME_CACHE_KEY, this.offlineRuntime(manifest, "stopped"));
      this.putJson("summary", summary);
      await this.syncUserSnapshot(summary);
      this.clearLifecycleTick();
      this.clearConnectorActivity();
      return { summary, backup: null };
    }

    this.setStatusValue("stopping");
    this.setLifecyclePhase("stopping", {
      reason,
      detail: "Saving the world before stopping Minecraft",
    });
    this.appendEvent("server.stopping", { reason });
    this.clearLifecycleTick();
    this.clearConnectorActivity();
    await this.publishSummary(manifest, "stopping", this.currentPresence());

    try {
      // Boot restores the latest backup, so destroying the container after a
      // failed backup would discard everything since the previous one. A
      // backup error must abort the stop and leave the container intact.
      const backup = await this.createAndStoreBackup(reason, {
        required: false,
      });
      await this.requestMinecraftStop();
      await this.killMinecraftProcesses();
      await this.destroyStoppedContainer();

      this.setStatusValue("stopped");
      this.setLifecyclePhase("stopped", {
        reason,
        detail: "Server stopped by request",
      });
      this.putJson(
        RUNTIME_CACHE_KEY,
        this.offlineRuntime(this.requireManifest(), "stopped"),
      );
      this.appendEvent("server.stopped", { reason, backupId: backup?.id });
      const summary = this.summaryFromManifest(
        this.requireManifest(),
        "stopped",
        emptyPresence(),
      );
      this.putJson("summary", summary);
      await this.syncUserSnapshot(summary);
      this.clearLifecycleTick();
      return { summary, backup };
    } catch (error) {
      await this.markLifecycleError(manifest, "server.stop_failed", error);
      throw error;
    }
  }

  async restartServer(
    reason = "manual-restart",
  ): Promise<{ summary: ServerSummary; runtime: MinecraftRuntimeStatus }> {
    this.assertNotDeleting();
    const manifest = this.requireManifest();
    this.setStatusValue("starting");
    this.setLifecyclePhase("starting", {
      reason,
      detail: "Restart requested; backing up and relaunching Minecraft",
    });
    this.appendEvent("server.restarting", { reason });
    await this.publishSummary(manifest, "starting", this.currentPresence());

    try {
      await this.createAndStoreBackup(reason);
      await this.killMinecraftProcesses();
      const runtime = await this.bootMinecraft(reason, {
        waitForMinecraft: true,
      });
      this.setLifecyclePhase("ready", {
        reason,
        detail: "Minecraft restarted and is accepting connections",
      });
      const summary = await this.syncRuntimeSummary(
        this.requireManifest(),
        "running",
        runtime,
      );
      await this.scheduleLifecycleTick();
      return { summary, runtime };
    } catch (error) {
      await this.markLifecycleError(manifest, "server.restart_failed", error);
      throw error;
    }
  }

  async runtimeStatus(): Promise<MinecraftRuntimeStatus> {
    const manifest = this.requireManifest();
    const current = this.getStatusValue();
    const runtime = this.cachedRuntime(manifest, current);
    const nextStatus = statusFromRuntime(current, runtime);
    if (nextStatus !== current) {
      await this.syncRuntimeSummary(this.requireManifest(), current, runtime);
    }
    return runtime;
  }

  async backup(reason = "manual-backup"): Promise<BackupRecord> {
    this.assertNotDeleting();
    if (this.getStatusValue() !== "running") {
      await this.startServer("backup-wake");
    }

    const backup = await this.createAndStoreBackup(reason);
    if (!backup) throw new Error("Backup was not created");
    const manifest = this.requireManifest();
    const summary = this.summaryFromManifest(
      manifest,
      this.getStatusValue(),
      this.currentPresence(),
    );
    this.putJson("summary", summary);
    await this.syncUserSnapshot(summary);
    return backup;
  }

  async restore(
    backupId: string,
  ): Promise<{ summary: ServerSummary; runtime: MinecraftRuntimeStatus }> {
    this.assertNotDeleting();
    const backup = this.getBackup(backupId);
    if (!backup) throw new Error("Backup not found");
    const manifest = this.requireManifest();
    this.setStatusValue("starting");
    this.setLifecyclePhase("restoring_backup", {
      reason: "manual-restore",
      backupId,
      detail: "Restoring the selected backup",
    });
    await this.publishSummary(manifest, "starting", this.currentPresence());

    try {
      await this.killMinecraftProcesses();
      await this.lifecycleStep(
        "restoring_backup",
        () => this.restoreBackup(backup.backup),
        {
          reason: "manual-restore",
          backupId,
          detail: "Restoring selected backup",
        },
      );
      this.putString("lastRestoredBackupId", backup.id);
      await this.lifecycleStep(
        "writing_manifest",
        () => this.writeManifest(this.requireManifest()),
        {
          reason: "manual-restore",
          detail: "Writing restored server manifest",
        },
      );
      const runtime = await this.bootMinecraft("manual-restore", {
        waitForMinecraft: true,
      });
      this.setLifecyclePhase("ready", {
        reason: "manual-restore",
        detail: "Backup restored and Minecraft is accepting connections",
      });
      this.appendEvent("backup.restored", { backupId });
      const summary = await this.syncRuntimeSummary(
        this.requireManifest(),
        "running",
        runtime,
      );
      await this.scheduleLifecycleTick();
      return { summary, runtime };
    } catch (error) {
      await this.markLifecycleError(manifest, "backup.restore_failed", error);
      throw error;
    }
  }

  async deleteServer(
    reason = "manual-delete",
  ): Promise<{ ok: true; serverId: string }> {
    const manifest = this.requireManifest();
    const existingBackups = this.listBackups();

    this.putString(DELETING_KEY, new Date().toISOString());
    this.clearLifecycleTick();
    this.clearConnectorActivity();
    this.setStatusValue("deleting");
    this.setLifecyclePhase("deleting", {
      reason,
      detail: "Deleting server runtime and retained backups",
    });
    this.appendEvent("server.deleting", { reason });
    await this.publishSummary(manifest, "deleting", emptyPresence());

    await this.killMinecraftProcesses().catch(() => undefined);
    await super.destroy().catch(() => undefined);
    await this.deleteBackupObjects(existingBackups);
    await this.env.USER_DO.getByName(manifest.ownerId).removeServer(
      manifest.serverId,
    );
    await this.env.IDENTITY_REGISTRY.getByName("primary").removeServerInvites({
      serverId: manifest.serverId,
      ownerId: manifest.ownerId,
    });
    this.ctx.storage.sql.exec("DELETE FROM backups");
    this.ctx.storage.sql.exec("DELETE FROM events");
    this.ctx.storage.sql.exec("DELETE FROM state");
    return { ok: true, serverId: manifest.serverId };
  }

  listBackups(): BackupRecord[] {
    return this.ctx.storage.sql
      .exec<BackupRow>(
        "SELECT id, json, created_at FROM backups ORDER BY created_at DESC, id DESC",
      )
      .toArray()
      .map((row) => JSON.parse(row.json) as BackupRecord);
  }

  getBackup(backupId: string): BackupRecord | null {
    const row = this.ctx.storage.sql
      .exec<BackupRow>(
        "SELECT id, json, created_at FROM backups WHERE id = ?",
        backupId,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.json) as BackupRecord) : null;
  }

  recentEvents(limit = 50): ServerEventRecord[] {
    return this.ctx.storage.sql
      .exec<EventRow>(
        "SELECT id, type, detail_json, created_at FROM events ORDER BY id DESC LIMIT ?",
        limit,
      )
      .toArray()
      .map((row) => ({
        type: row.type,
        detail: row.detail_json,
        createdAt: row.created_at,
      }));
  }

  async executeRconCommand(
    command: string,
  ): Promise<{ command: string; output: string }> {
    this.assertNotDeleting();
    if (this.getStatusValue() !== "running") {
      await this.startServer("rcon-command");
    }
    return {
      command,
      output: await this.rcon(command),
    };
  }

  async startDynmapRender(
    reason = "dynmap-render",
  ): Promise<{ command: string; output: string }> {
    this.assertNotDeleting();
    const manifest = this.requireManifest();
    if (!manifest.dynmap.enabled) {
      throw new Error("Dynmap is not enabled for this server");
    }
    if (this.getStatusValue() !== "running") {
      await this.startServer(reason);
    } else {
      await this.rcon("list");
    }
    const radius = this.dynmapInitialRenderRadius();
    return this.queueDynmapRender("dynmap-radius-render", `dynmap radiusrender world 0 0 ${radius}`, {
      reason,
      detail: `Starting Dynmap render around spawn (${radius} block radius)`,
      eventType: "dynmap.render_started",
    });
  }

  terminal(_request: Request, _options?: { cwd?: string }): Promise<Response> {
    throw new Error("terminal() must be called on the getSandbox() proxy");
  }

  async getBridgeEndpoint(
    hostname: string,
    bridgeToken: string,
    publicBaseHost?: string,
  ): Promise<{ url: string; token: string }> {
    this.assertNotDeleting();
    const manifest = this.requireManifest();
    const exposed = await this.lifecycleStep(
      "exposing_bridge",
      () =>
        this.exposePort(BRIDGE_PORT, {
          hostname,
          name: "minecraft-java-ws-bridge",
          token: "mcbridge",
        }),
      {
        reason: "bridge-wake",
        detail: "Opening websocket bridge endpoint",
      },
    );
    this.setLifecyclePhase("ready", {
      reason: "bridge-wake",
      detail: "Bridge is open for Minecraft traffic",
    });
    await this.syncUserSnapshot();
    return {
      url: publicBaseHost
        ? `wss://${publicBaseHost}/api/connect/bridge/${manifest.serverId}`
        : exposed.url.replace(/^https:/, "wss:"),
      token: bridgeToken,
    };
  }

  async getDynmapPreview(hostname: string): Promise<{ url: string } | null> {
    this.assertNotDeleting();
    const manifest = this.requireManifest();
    if (!manifest.dynmap.enabled) return null;
    await this.startServer("dynmap-preview");
    const exposed = await this.exposePort(DYNMAP_PORT, {
      hostname,
      name: "dynmap",
      token: "dynmap",
    });
    return { url: exposed.url };
  }

  async getDynmapRuntimeStatus(): Promise<unknown> {
    this.assertNotDeleting();
    const manifest = this.requireManifest();
    if (!manifest.dynmap.enabled) {
      return { ok: true, enabled: false };
    }
    const secret = await dynmapSyncSecret(this.env);
    const response = await this.withTimeout(
      this.containerFetch(
        new Request("http://localhost/dynmap-status", {
          headers: {
            "x-cubeflare-dynmap-secret": secret,
          },
        }),
        BRIDGE_PORT,
      ),
      5_000,
      "Dynmap bridge status",
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Dynmap status failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
      );
    }
    return response.json();
  }

  async getRuntimeStatus(): Promise<MinecraftRuntimeStatus> {
    const manifest = this.getManifest();
    const process = await this.getMinecraftProcess();
    const activity = this.currentConnectorActivity();
    let rconHealthy = false;
    const list = await this.rcon("list")
      .then((output) => {
        rconHealthy = true;
        return parseListResponse(output);
      })
      .catch(() => ({
        online: 0,
        max: manifest?.maxPlayers ?? 0,
        players: [],
      }));
    const processState =
      process === null
        ? "missing"
        : process.status === "running"
          ? "running"
          : process.status === "completed" ||
              process.status === "failed" ||
              process.status === "killed"
            ? "exited"
            : "error";

    return {
      process: processState,
      containerRunning: this.containerState().container?.running === true,
      playersOnline: list.online,
      activeBridgeConnections: activity.activeBridgeConnections,
      maxPlayers: list.max || manifest?.maxPlayers || 0,
      players: list.players,
      motd: manifest?.motd,
      version: manifest?.version,
      lastBackupAt:
        this.latestBackup()?.createdAt ??
        this.getString("lastBackupAt") ??
        undefined,
      joinHost: manifest ? this.joinHost(manifest) : undefined,
      location: manifest?.location?.actual,
      rconHealthy,
    };
  }

  async lifecycleTick(): Promise<void> {
    this.clearLifecycleTick();
    if (this.isDeleting()) return;
    const manifest = this.getManifest();
    const current = this.getStatusValue();
    const activity = this.currentConnectorActivity();
    const decision = planLifecycleAlarm({
      hasManifest: Boolean(manifest),
      containerRunning: this.containerState().container?.running === true,
      status: current,
      activeBridgeConnections: activity.activeBridgeConnections,
    });

    if (!decision.inspectRuntime) {
      return;
    }

    try {
      if (decision.runBackup) {
        await this.createAndStoreBackup("periodic", { required: false });
      }
      const runtime = await this.getRuntimeStatus();
      await this.syncRuntimeSummary(this.requireManifest(), current, runtime);
      if (shouldRenewContainerActivity(activity.activeBridgeConnections)) {
        await this.touchBridgeHealth();
      }
    } catch (error) {
      this.appendEvent("alarm.error", {
        message: error instanceof Error ? error.message : String(error),
      });
      await this.syncUserSnapshot();
    } finally {
      await this.scheduleLifecycleTick();
    }
  }

  async writeManifest(manifest: MinecraftServerManifest): Promise<void> {
    await this.mkdir(`${SERVER_DIR}/.cubeflare`, { recursive: true });
    await this.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  }

  private normalizedRuntimeManifest(
    manifest: MinecraftServerManifest,
  ): MinecraftServerManifest {
    const compatibilityManifest = normalizeManifestCompatibility(manifest);
    const memoryMin = normalizeMinecraftMemory(compatibilityManifest.memoryMin);
    const memoryMax = normalizeMinecraftMemory(compatibilityManifest.memoryMax);
    if (
      compatibilityManifest === manifest &&
      memoryMin === manifest.memoryMin &&
      memoryMax === manifest.memoryMax
    ) {
      return manifest;
    }
    const next = { ...compatibilityManifest, memoryMin, memoryMax };
    this.putJson("manifest", next);
    this.appendEvent("server.runtime_profile_adjusted", {
      previousMemoryMin: manifest.memoryMin,
      previousMemoryMax: manifest.memoryMax,
      memoryMin,
      memoryMax,
    });
    return next;
  }

  private async bootMinecraft(
    reason: string,
    options: StartOptions,
  ): Promise<MinecraftRuntimeStatus> {
    if (!this.bootPromise) {
      this.bootPromise = this.bootMinecraftInner(reason).finally(() => {
        this.bootPromise = null;
      });
    }
    const runtime = await this.bootPromise;
    if (options.waitForMinecraft && !this.isRuntimeReady(runtime)) {
      await this.waitForMinecraftReady();
      return this.lifecycleStep(
        "checking_runtime",
        () => this.getRuntimeStatus(),
        {
          reason,
          detail: "Reading Minecraft runtime health",
        },
      );
    }
    return runtime;
  }

  private async bootMinecraftInner(
    reason: string,
  ): Promise<MinecraftRuntimeStatus> {
    const manifest = this.normalizedRuntimeManifest(this.requireManifest());
    const existing = await this.lifecycleStep(
      "checking_process",
      () => this.getMinecraftProcess(),
      {
        reason,
        detail: "Checking for an existing Minecraft process",
      },
    );
    if (existing?.status === "running") {
      await this.setKeepAlive(false);
      return this.lifecycleStep(
        "checking_runtime",
        () => this.getRuntimeStatus(),
        {
          reason,
          detail: "Existing Minecraft process is running",
        },
      );
    }

    await this.lifecycleStep(
      "writing_manifest",
      () => this.writeManifest(manifest),
      {
        reason,
        detail: "Writing Minecraft launch manifest",
      },
    );
    const latest = this.latestBackup();
    if (latest) {
      await this.lifecycleStep(
        "restoring_backup",
        () => this.restoreBackup(latest.backup),
        {
          reason,
          backupId: latest.id,
          detail: "Restoring latest backup",
        },
      );
      this.putString("lastRestoredBackupId", latest.id);
      this.appendEvent("backup.restored_on_start", {
        backupId: latest.id,
        reason,
      });
      await this.lifecycleStep(
        "writing_manifest",
        () => this.writeManifest(this.requireManifest()),
        {
          reason,
          detail: "Writing manifest after backup restore",
        },
      );
    }

    await this.startProcesses(this.requireManifest(), reason);
    return this.lifecycleStep(
      "checking_runtime",
      () => this.getRuntimeStatus(),
      {
        reason,
        detail: "Reading runtime after process launch",
      },
    );
  }

  private async startProcesses(
    manifest: MinecraftServerManifest,
    reason: string,
  ): Promise<void> {
    await this.lifecycleStep(
      "writing_manifest",
      () => this.writeManifest(manifest),
      {
        reason,
        detail: "Writing process environment manifest",
      },
    );
    const existing = await this.lifecycleStep(
      "checking_process",
      () => this.getMinecraftProcess(),
      {
        reason,
        detail: "Checking Minecraft process before launch",
      },
    );
    if (existing?.status === "running") {
      await this.setKeepAlive(false);
      return;
    }

    const [bridgeSecret, dynmapSecret] = await Promise.all([
      minecraftBridgeSecret(this.env),
      dynmapSyncSecret(this.env),
    ]);
    const process = await this.lifecycleStep(
      "starting_minecraft",
      () =>
        this.startProcess(
          `/opt/cubeflare/bin/cubeflare-run-server.sh ${shellQuote(MANIFEST_PATH)}`,
          {
            processId: MINECRAFT_PROCESS,
            cwd: SERVER_DIR,
            autoCleanup: false,
            env: {
              CUBEFLARE_START_REASON: reason,
              CUBEFLARE_MANIFEST_PATH: MANIFEST_PATH,
              CUBEFLARE_RCON_PASSWORD: manifest.rconPassword,
              CUBEFLARE_DYNMAP_BUCKET_PREFIX: manifest.dynmap.publicPathPrefix,
              CUBEFLARE_SERVER_ID: manifest.serverId,
              CUBEFLARE_BRIDGE_SECRET: bridgeSecret,
              CUBEFLARE_DYNMAP_SYNC_SECRET: dynmapSecret,
              CUBEFLARE_INTERNAL_BASE_URL: internalBaseUrlForManifest(this.env, manifest),
              CUBEFLARE_BRIDGE_PORT: String(BRIDGE_PORT),
              CUBEFLARE_MINECRAFT_HOST: "127.0.0.1",
              CUBEFLARE_MINECRAFT_PORT: String(MINECRAFT_PORT),
              CUBEFLARE_DYNMAP_ENABLED: String(manifest.dynmap.enabled),
              CUBEFLARE_DYNMAP_ROOT: `${SERVER_DIR}/plugins/dynmap/web`,
              CUBEFLARE_DYNMAP_LOCAL_BASE_URL: "http://127.0.0.1:8123",
              MEMORY_MIN: manifest.memoryMin,
              MEMORY_MAX: manifest.memoryMax,
            },
          },
        ),
      {
        reason,
        detail: "Launching Minecraft server process",
      },
    );

    await this.lifecycleStep(
      "waiting_bridge",
      () =>
        process.waitForPort(BRIDGE_PORT, {
          path: "/health",
          status: 200,
          timeout: 30_000,
        }),
      {
        reason,
        detail: "Waiting for Cubeflare bridge health",
      },
    );

    await this.setKeepAlive(false);
  }

  private async waitForMinecraftReady(process?: Process | null): Promise<void> {
    const minecraftProcess = process ?? (await this.getMinecraftProcess());
    if (!minecraftProcess) {
      throw new Error("Minecraft process has not started");
    }
    await this.lifecycleStep(
      "waiting_minecraft_port",
      () =>
        minecraftProcess.waitForPort(MINECRAFT_PORT, {
          mode: "tcp",
          timeout: 180_000,
        }),
      {
        detail: "Waiting for Minecraft TCP port 25565",
      },
    );
    await this.lifecycleStep(
      "waiting_rcon",
      async () => {
        await minecraftProcess.waitForPort(RCON_PORT, {
          mode: "tcp",
          timeout: 180_000,
        });
        await this.rcon("list");
      },
      {
        detail: "Waiting for RCON and verifying command access",
      },
    );
    await this.lifecycleStep(
      "checking_bridge",
      () => this.touchBridgeHealth(),
      {
        detail: "Verifying Cubeflare bridge after Minecraft startup",
      },
    );
    await this.ensureDynmapInitialRender();
  }

  private async touchBridgeHealth(): Promise<void> {
    const response = await this.withTimeout(
      this.containerFetch(new Request("http://localhost/health"), BRIDGE_PORT),
      5_000,
      "Bridge health",
    );
    if (!response.ok) {
      throw new Error(
        `Bridge health check failed with HTTP ${response.status}`,
      );
    }
  }

  private async createBackupRecord(reason: string): Promise<BackupRecord> {
    const manifest = this.requireManifest();
    const startedAt = new Date().toISOString();
    let saveDisabled = false;

    this.setLifecyclePhase("creating_backup", {
      reason,
      detail: "Flushing world data before backup",
    });
    await this.lifecycleStep(
      "flushing_world",
      async () => {
        await this.rcon("save-off");
        saveDisabled = true;
        await this.rcon("save-all flush");
      },
      {
        reason,
        detail: "Running RCON save-all flush for a consistent world snapshot",
      },
    );
    try {
      const backup = await this.lifecycleStep(
        "creating_backup",
        () =>
          this.createBackup({
            dir: SERVER_DIR,
            name: `${manifest.serverId}-${reason}-${Date.now()}`,
            excludes: minecraftBackupExcludes(),
            compression: {
              format: "lz4",
              threads: 8,
            },
          }),
        {
          reason,
          detail: "Creating compressed sandbox backup",
        },
      );
      this.putString("lastBackupAt", startedAt);
      return {
        id: backup.id,
        backup,
        serverId: manifest.serverId,
        reason,
        createdAt: startedAt,
        sizeBytes: await this.backupSizeBytes(backup.id),
        status: "ready",
      };
    } finally {
      if (saveDisabled) {
        await this.rcon("save-on").catch((error) =>
          this.appendEvent("backup.save_on_failed", {
            reason,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      if (this.getStatusValue() === "running") {
        this.setLifecyclePhase("ready", {
          reason,
          detail: "Backup complete; Minecraft is accepting connections",
        });
        await this.syncUserSnapshot();
      }
    }
  }

  private createAndStoreBackup(
    reason: string,
    options: { required?: boolean } = {},
  ): Promise<BackupRecord | null> {
    const required = options.required ?? true;
    return this.enqueueBackup(async () => {
      if (this.isDeleting()) {
        if (required) throw new Error("Server is being deleted");
        return null;
      }

      try {
        const backup = await this.createBackupRecord(reason);
        if (this.isDeleting()) {
          await this.deleteBackupObjects([backup]);
          if (required) throw new Error("Server is being deleted");
          return null;
        }

        await this.insertBackup(backup);
        this.appendEvent("backup.created", { backupId: backup.id, reason });
        await this.syncUserSnapshot();
        return backup;
      } catch (error) {
        this.appendEvent("backup.failed", {
          reason,
          message: error instanceof Error ? error.message : String(error),
        });
        await this.syncUserSnapshot();
        throw error;
      }
    });
  }

  private enqueueBackup<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.backupQueue.then(operation, operation);
    this.backupQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async insertBackup(backup: BackupRecord): Promise<void> {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO backups (id, json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at
      `,
      backup.id,
      JSON.stringify(backup),
      backup.createdAt,
    );
    this.putString("lastBackupAt", backup.createdAt);
    await this.pruneBackups();
  }

  private latestBackup(): BackupRecord | null {
    return this.listBackups()[0] ?? null;
  }

  private async pruneBackups(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<BackupRow>(
        "SELECT id, json, created_at FROM backups ORDER BY created_at DESC, id DESC",
      )
      .toArray();
    const stale = rows.slice(maxBackupsPerServer(this.env));
    for (const row of stale) {
      this.ctx.storage.sql.exec("DELETE FROM backups WHERE id = ?", row.id);
      await this.deleteBackupObjects([JSON.parse(row.json) as BackupRecord]);
      this.appendEvent("backup.pruned", { backupId: row.id });
    }
  }

  private async deleteBackupObjects(backups: BackupRecord[]): Promise<void> {
    const ids = [
      ...new Set(backups.map((backup) => backup.id).filter(Boolean)),
    ];
    for (const id of ids) {
      await Promise.all([
        this.env.BUCKET.delete(`backups/${id}/data.sqsh`),
        this.env.BUCKET.delete(`backups/${id}/meta.json`),
      ]).catch(() => undefined);
    }
  }

  private async backupSizeBytes(backupId: string): Promise<number | undefined> {
    const meta = await this.env.BUCKET.get(
      `backups/${backupId}/meta.json`,
    ).catch(() => null);
    const metadata = await meta
      ?.json<{ sizeBytes?: unknown }>()
      .catch(() => null);
    return typeof metadata?.sizeBytes === "number" &&
      Number.isFinite(metadata.sizeBytes)
      ? metadata.sizeBytes
      : undefined;
  }

  private async requestMinecraftStop(): Promise<void> {
    const process = await this.getMinecraftProcess();
    if (process?.status !== "running") return;
    await this.rcon("stop").catch(() => undefined);
    await this.waitForProcessStopped(
      MINECRAFT_PROCESS,
      PROCESS_STOP_GRACE_MS,
    ).catch(() => undefined);
  }

  private async killMinecraftProcesses(): Promise<void> {
    for (const processId of MANAGED_PROCESS_IDS) {
      await this.killProcessAndWait(processId);
    }
  }

  private async destroyStoppedContainer(): Promise<void> {
    if (this.containerState().container?.running !== true) return;
    await super.destroy();
  }

  private async killProcessAndWait(processId: string): Promise<void> {
    const process = await this.getProcess(processId).catch(() => null);
    if (process?.status !== "running") return;
    await process.kill().catch(() => undefined);
    await this.waitForProcessStopped(processId, PROCESS_KILL_WAIT_MS);
  }

  private async waitForProcessStopped(
    processId: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const process = await this.getProcess(processId).catch(() => null);
      if (!process || process.status !== "running") return;
      await delay(Math.min(PROCESS_STOP_POLL_MS, deadline - Date.now()));
    }
    throw new Error(`Process ${processId} did not stop within ${timeoutMs}ms`);
  }

  private async getMinecraftProcess(): Promise<Process | null> {
    return this.getProcess(MINECRAFT_PROCESS).catch(() => null);
  }

  private async rcon(command: string): Promise<string> {
    const manifest = this.requireManifest();
    const port = this.containerState().container?.getTcpPort(RCON_PORT);
    if (!port) {
      throw new Error("RCON port is not available");
    }
    return executeRcon(port, manifest.rconPassword, command);
  }

  private async ensureDynmapInitialRender(): Promise<void> {
    const manifest = this.requireManifest();
    if (!manifest.dynmap.enabled) return;
    const signature = dynmapInitialRenderSignature(manifest);
    if (this.getString(DYNMAP_INITIAL_RENDER_KEY) === signature) return;

    const radius = this.dynmapInitialRenderRadius();
    const command = `dynmap radiusrender world 0 0 ${radius}`;
    try {
      await this.queueDynmapRender("dynmap-initial-render", command, {
        reason: "startup",
        detail: `Starting initial Dynmap render around spawn (${radius} block radius)`,
        eventType: "dynmap.initial_render_started",
      });
      this.putString(DYNMAP_INITIAL_RENDER_KEY, signature);
    } catch (error) {
      this.appendEvent("dynmap.initial_render_failed", {
        command,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async queueDynmapRender(
    lifecycleKey: string,
    command: string,
    options: { reason: string; detail: string; eventType: string },
  ): Promise<{ command: string; output: string }> {
    const output = await this.lifecycleStep(
      lifecycleKey,
      () => this.rcon(command),
      {
        reason: options.reason,
        detail: options.detail,
      },
    );
    this.appendEvent(options.eventType, {
      command,
      output: output.slice(0, 500),
    });
    return { command, output };
  }

  private dynmapInitialRenderRadius(): number {
    return parsePositiveInt(
      this.env.DYNMAP_INITIAL_RENDER_RADIUS,
      DYNMAP_DEFAULT_INITIAL_RENDER_RADIUS,
      128,
      8192,
    );
  }

  private async lifecycleStep<T>(
    key: string,
    action: () => Promise<T>,
    options: { reason?: string; detail?: string; backupId?: string } = {},
  ): Promise<T> {
    const started = Date.now();
    const label = lifecyclePhaseLabel(key);
    this.setLifecyclePhase(key, { ...options, label });
    await this.syncUserSnapshot();
    try {
      const result = await action();
      this.recordLifecycleStep({
        key,
        label,
        status: "ok",
        durationMs: Date.now() - started,
        completedAt: new Date().toISOString(),
        detail: options.detail,
        reason: options.reason,
        backupId: options.backupId,
      });
      await this.syncUserSnapshot();
      return result;
    } catch (error) {
      this.recordLifecycleStep({
        key,
        label,
        status: "error",
        durationMs: Date.now() - started,
        completedAt: new Date().toISOString(),
        detail: options.detail,
        reason: options.reason,
        backupId: options.backupId,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.syncUserSnapshot();
      throw error;
    }
  }

  private recordLifecycleStep(step: ServerLifecycleStep): void {
    const phase = this.currentLifecyclePhase();
    if (phase) {
      this.putJson(LIFECYCLE_PHASE_KEY, {
        ...phase,
        updatedAt: step.completedAt,
        elapsedMs: Date.now() - Date.parse(phase.startedAt),
        lastCompletedStep: step,
      });
    }
    this.appendEvent("lifecycle.step", step);
    this.logLifecycle("step", step);
  }

  private setLifecyclePhase(
    key: string,
    options: {
      label?: string;
      reason?: string;
      detail?: string;
      backupId?: string;
    } = {},
  ): ServerLifecyclePhase {
    const now = new Date().toISOString();
    const previous = this.getJson<ServerLifecyclePhase>(LIFECYCLE_PHASE_KEY);
    const startedAt = previous?.key === key ? previous.startedAt : now;
    const phase: ServerLifecyclePhase = {
      key,
      label: options.label ?? lifecyclePhaseLabel(key),
      startedAt,
      updatedAt: now,
      elapsedMs: Date.now() - Date.parse(startedAt),
      detail: options.detail,
      reason: options.reason,
      backupId: options.backupId,
      lastCompletedStep: previous?.lastCompletedStep,
    };
    this.putJson(LIFECYCLE_PHASE_KEY, phase);

    const summary = this.getJson<ServerSummary>("summary");
    if (summary) {
      this.putJson("summary", { ...summary, lifecycle: phase });
    }
    this.logLifecycle("phase", phase);
    return phase;
  }

  private currentLifecyclePhase(): ServerLifecyclePhase | null {
    const phase = this.getJson<ServerLifecyclePhase>(LIFECYCLE_PHASE_KEY);
    if (!phase) return null;
    return {
      ...phase,
      elapsedMs: Date.now() - Date.parse(phase.startedAt),
    };
  }

  private logLifecycle(
    kind: "phase" | "step",
    detail: ServerLifecyclePhase | ServerLifecycleStep,
  ): void {
    const manifest = this.getManifest();
    console.log(
      JSON.stringify({
        event: `cubeflare.lifecycle.${kind}`,
        serverId: manifest?.serverId,
        detail,
      }),
    );
  }

  private async publishSummary(
    manifest: MinecraftServerManifest,
    status: ServerSummary["status"],
    presence: PresenceMetrics,
  ): Promise<ServerSummary> {
    const summary = this.summaryFromManifest(manifest, status, presence);
    this.putJson("summary", summary);
    await this.syncUserSnapshot(summary);
    return summary;
  }

  private async syncUserSnapshot(
    summary = this.getSummary(),
    runtime = this.getJson<MinecraftRuntimeStatus>(RUNTIME_CACHE_KEY),
  ): Promise<void> {
    const manifest = this.getManifest();
    if (!manifest || !summary) return;
    await this.env.USER_DO.getByName(manifest.ownerId).upsertServerSnapshot(
      this.controlSnapshot(summary, runtime),
    );
  }

  private controlSnapshot(
    summary: ServerSummary,
    runtime: MinecraftRuntimeStatus | null,
  ): ServerControlSnapshot {
    return {
      summary,
      manifest: this.requireManifest(),
      runtime,
      backups: this.listBackups(),
      events: this.recentEvents(40),
      updatedAt: new Date().toISOString(),
    };
  }

  private async syncRuntimeSummary(
    manifest: MinecraftServerManifest,
    current: ServerSummary["status"],
    runtime: MinecraftRuntimeStatus,
  ): Promise<ServerSummary> {
    this.putJson(RUNTIME_CACHE_KEY, runtime);
    const status = statusFromRuntime(current, runtime);
    this.setStatusValue(status);
    const summary = this.summaryFromManifest(
      manifest,
      status,
      presenceFromRuntime(runtime),
    );
    this.putJson("summary", summary);
    await this.syncUserSnapshot(summary, runtime);
    return summary;
  }

  private async markLifecycleError(
    manifest: MinecraftServerManifest,
    eventType: string,
    error: unknown,
  ): Promise<void> {
    this.setStatusValue("error");
    this.setLifecyclePhase("error", {
      detail: error instanceof Error ? error.message : String(error),
    });
    const summary = this.summaryFromManifest(
      manifest,
      "error",
      this.currentPresence(),
    );
    this.putJson("summary", summary);
    this.appendEvent(eventType, {
      message: error instanceof Error ? error.message : String(error),
    });
    await this.syncUserSnapshot(summary);
  }

  private async scheduleLifecycleTick(): Promise<void> {
    const manifest = this.getManifest();
    const status = this.getStatusValue();
    if (!manifest || (status !== "running" && status !== "starting")) return;

    const now = Date.now();
    const scheduledAt = this.getString(LIFECYCLE_TICK_SCHEDULED_AT_KEY);
    const scheduledAtMs = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
    if (Number.isFinite(scheduledAtMs) && scheduledAtMs > now + 1000) return;

    const delaySeconds = backupIntervalSeconds(this.env);
    const next = new Date(now + delaySeconds * 1000).toISOString();
    await this.schedule(delaySeconds, "lifecycleTick");
    this.putString(LIFECYCLE_TICK_SCHEDULED_AT_KEY, next);
  }

  private offlineRuntime(
    manifest: MinecraftServerManifest,
    status: ServerSummary["status"],
  ): MinecraftRuntimeStatus {
    return {
      process: status === "error" ? "error" : "missing",
      containerRunning: false,
      playersOnline: 0,
      activeBridgeConnections: 0,
      maxPlayers: manifest.maxPlayers,
      players: [],
      motd: manifest.motd,
      version: manifest.version,
      lastBackupAt:
        this.latestBackup()?.createdAt ??
        this.getString("lastBackupAt") ??
        undefined,
      joinHost: this.joinHost(manifest),
      location: manifest.location?.actual,
      rconHealthy: false,
    };
  }

  private cachedRuntime(
    manifest: MinecraftServerManifest,
    status: ServerSummary["status"],
  ): MinecraftRuntimeStatus {
    const containerRunning = this.containerState().container?.running === true;
    if (!containerRunning) {
      return this.offlineRuntime(
        manifest,
        status === "error" ? "error" : "stopped",
      );
    }

    const cached = this.getJson<MinecraftRuntimeStatus>(RUNTIME_CACHE_KEY);
    const activity = this.currentConnectorActivity();
    const process =
      cached?.process ??
      (status === "running" || status === "starting" || status === "stopping"
        ? "running"
        : "missing");

    return {
      process,
      containerRunning,
      playersOnline: cached?.playersOnline ?? 0,
      activeBridgeConnections: activity.activeBridgeConnections,
      maxPlayers: cached?.maxPlayers || manifest.maxPlayers,
      players: cached?.players ?? [],
      motd: cached?.motd ?? manifest.motd,
      version: cached?.version ?? manifest.version,
      lastBackupAt:
        this.latestBackup()?.createdAt ??
        this.getString("lastBackupAt") ??
        undefined,
      joinHost: this.joinHost(manifest),
      location: manifest.location?.actual,
      rconHealthy: cached?.rconHealthy ?? false,
    };
  }

  private async readyCachedRuntime(
    manifest: MinecraftServerManifest,
  ): Promise<MinecraftRuntimeStatus | null> {
    const runtime = this.cachedRuntime(manifest, "running");
    if (!this.isRuntimeReady(runtime)) return null;
    return (await this.isTcpPortAccepting(MINECRAFT_PORT, 1500))
      ? runtime
      : null;
  }

  private isRuntimeReady(runtime: MinecraftRuntimeStatus): boolean {
    return (
      runtime.containerRunning &&
      runtime.process === "running" &&
      runtime.rconHealthy
    );
  }

  private async isTcpPortAccepting(
    portNumber: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const tcpPort = this.containerState().container?.getTcpPort(portNumber);
    if (!tcpPort) return false;
    const socket = tcpPort.connect(`localhost:${portNumber}`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        socket.opened,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("TCP probe timed out")),
            timeoutMs,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
      await socket.close().catch(() => undefined);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private currentConnectorActivity(
    now = Date.now(),
  ): ConnectorActivitySnapshot {
    const activity = summarizeConnectorActivitySessions(
      this.getConnectorActivitySessions(),
      now,
    );
    if (activity.changed) {
      this.putConnectorActivitySessions(activity.sessions);
    }
    return activity;
  }

  private currentPresence(): PresenceMetrics {
    const summary = this.getJson<ServerSummary>("summary");
    const runtime = this.getJson<MinecraftRuntimeStatus>(RUNTIME_CACHE_KEY);
    return {
      playersOnline: runtime?.playersOnline ?? summary?.playersOnline ?? 0,
      activeBridgeConnections:
        this.currentConnectorActivity().activeBridgeConnections,
    };
  }

  private clearConnectorActivity(): void {
    this.deleteString(CONNECTOR_ACTIVITY_SESSIONS_KEY);
  }

  private getConnectorActivitySessions(): ConnectorActivitySessions {
    return (
      this.getJson<ConnectorActivitySessions>(
        CONNECTOR_ACTIVITY_SESSIONS_KEY,
      ) ?? {}
    );
  }

  private putConnectorActivitySessions(
    sessions: ConnectorActivitySessions,
  ): void {
    if (Object.keys(sessions).length === 0) {
      this.clearConnectorActivity();
      return;
    }
    this.putJson(CONNECTOR_ACTIVITY_SESSIONS_KEY, sessions);
  }

  private clearLifecycleTick(): void {
    this.deleteString(LIFECYCLE_TICK_SCHEDULED_AT_KEY);
  }

  private summaryFromManifest(
    manifest: MinecraftServerManifest,
    status: ServerSummary["status"],
    presence: PresenceMetrics,
  ): ServerSummary {
    const latest = this.latestBackup();
    return {
      id: manifest.serverId,
      ownerId: manifest.ownerId,
      name: manifest.name,
      preset: manifest.preset,
      version: manifest.version,
      status,
      playersOnline: presence.playersOnline,
      activeBridgeConnections: presence.activeBridgeConnections,
      maxPlayers: manifest.maxPlayers,
      lastBackupAt:
        latest?.createdAt ?? this.getString("lastBackupAt") ?? undefined,
      joinHost: this.joinHost(manifest),
      dynmapEnabled: manifest.dynmap.enabled,
      locationPreference: manifest.location?.preference ?? "auto",
      runtimeLocation: manifest.location?.actual,
      lifecycle: this.currentLifecyclePhase() ?? undefined,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    };
  }

  private requireManifest(): MinecraftServerManifest {
    const manifest = this.getManifest();
    if (!manifest) throw new Error("Server does not exist");
    return manifest;
  }

  private getStatusValue(): ServerSummary["status"] {
    const status = this.getString("status");
    if (
      status === "stopped" ||
      status === "starting" ||
      status === "running" ||
      status === "stopping" ||
      status === "deleting" ||
      status === "error"
    ) {
      return status;
    }
    return "stopped";
  }

  private setStatusValue(value: ServerSummary["status"]): void {
    this.putString("status", value);
  }

  private isDeleting(): boolean {
    return (
      this.getString(DELETING_KEY) !== null ||
      this.getStatusValue() === "deleting"
    );
  }

  private assertNotDeleting(): void {
    if (this.isDeleting()) {
      throw new Error("Server is being deleted");
    }
  }

  private appendEvent(type: string, detail: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (type, detail_json, created_at) VALUES (?, ?, ?)",
      type,
      JSON.stringify(detail),
      new Date().toISOString(),
    );
  }

  private getString(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<StateRow>("SELECT key, value FROM state WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private putString(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      key,
      value,
    );
  }

  private deleteString(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM state WHERE key = ?", key);
  }

  private getJson<T>(key: string): T | null {
    const value = this.getString(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  private putJson<T>(key: string, value: T): void {
    this.putString(key, JSON.stringify(value));
  }

  private joinHost(manifest: MinecraftServerManifest): string {
    return publicJoinHost(this.env, manifest);
  }

  private containerState(): ContainerStateWithTcp {
    return this.ctx as ContainerStateWithTcp;
  }
}

export function backupIntervalSeconds(env: AppEnv): number {
  return parsePositiveInt(env.BACKUP_INTERVAL_SECONDS, 300, 60, 3600);
}

export function maxBackupsPerServer(env: AppEnv): number {
  return parsePositiveInt(env.MAX_BACKUPS_PER_SERVER, 5, 1, 50);
}

export function connectorActivityTtlSeconds(env: AppEnv): number {
  return parsePositiveInt(env.CONNECTOR_ACTIVITY_TTL_SECONDS, 900, 60, 86_400);
}

function emptyPresence(): PresenceMetrics {
  return {
    playersOnline: 0,
    activeBridgeConnections: 0,
  };
}

function presenceFromRuntime(runtime: MinecraftRuntimeStatus): PresenceMetrics {
  return {
    playersOnline: runtime.playersOnline,
    activeBridgeConnections: runtime.activeBridgeConnections,
  };
}

function sameLocationObservation(
  left: RuntimeLocationObservation | undefined,
  right: RuntimeLocationObservation,
): boolean {
  return (
    left?.colo === right.colo &&
    left?.region === right.region &&
    left?.country === right.country &&
    left?.source === right.source
  );
}

function lifecyclePhaseLabel(key: string): string {
  switch (key) {
    case "starting":
      return "Starting server";
    case "container_onstart":
      return "Container starting";
    case "checking_process":
      return "Checking process";
    case "writing_manifest":
      return "Writing manifest";
    case "restoring_backup":
      return "Restoring backup";
    case "starting_bridge":
      return "Starting bridge";
    case "starting_dynmap":
      return "Starting dynmap sync";
    case "dynmap-initial-render":
      return "Starting dynmap render";
    case "dynmap-radius-render":
      return "Starting dynmap render";
    case "starting_minecraft":
      return "Launching Minecraft";
    case "waiting_bridge":
      return "Waiting for bridge";
    case "checking_bridge":
      return "Checking bridge";
    case "waiting_minecraft_port":
      return "Waiting for Minecraft port";
    case "waiting_rcon":
      return "Waiting for RCON";
    case "checking_runtime":
      return "Checking runtime";
    case "exposing_bridge":
      return "Opening bridge";
    case "creating_backup":
      return "Creating backup";
    case "flushing_world":
      return "Flushing world";
    case "stopping":
      return "Stopping server";
    case "stopped":
      return "Stopped";
    case "deleting":
      return "Deleting server";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    default:
      return key
        .split(/[_-]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function dynmapInitialRenderSignature(
  manifest: MinecraftServerManifest,
): string {
  return [
    manifest.serverId,
    manifest.preset,
    manifest.version,
    manifest.seed ?? "",
  ].join(":");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
