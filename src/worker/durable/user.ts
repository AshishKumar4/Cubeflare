import { DurableObject } from 'cloudflare:workers';
import type { AppEnv, AuthenticatedUser, ServerControlSnapshot, ServerSummary } from '../types';

export type StoredProfile = {
  id: string;
  email: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

type ProfileRow = {
  id: string;
  email: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id_hash: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  user_agent: string | null;
  ip_prefix: string | null;
};

type CliTokenRow = {
  id_hash: string;
  label: string;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
};

type ServerRow = {
  server_id: string;
  name: string;
  summary_json: string;
  created_at: string;
  updated_at: string;
};

type ServerSnapshotRow = {
  server_id: string;
  snapshot_json: string;
  updated_at: string;
};

export class UserDO extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS profile (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          user_agent TEXT,
          ip_prefix TEXT
        );

        CREATE TABLE IF NOT EXISTS cli_tokens (
          id_hash TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );

        CREATE TABLE IF NOT EXISTS servers (
          server_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_snapshots (
          server_id TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  createAccount(input: {
    id: string;
    email: string;
    displayName: string;
    passwordSalt: string;
    passwordHash: string;
  }): StoredProfile {
    const existing = this.getProfile();
    if (existing) {
      throw new Error('User profile already exists');
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        INSERT INTO profile (
          id, email, display_name, password_salt, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      input.id,
      input.email,
      input.displayName,
      input.passwordSalt,
      input.passwordHash,
      now,
      now
    );
    return {
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      passwordSalt: input.passwordSalt,
      passwordHash: input.passwordHash,
      createdAt: now,
      updatedAt: now
    };
  }

  getProfile(): StoredProfile | null {
    const row = this.ctx.storage.sql
      .exec<ProfileRow>(
        `
          SELECT id, email, display_name, password_salt, password_hash, created_at, updated_at
          FROM profile
          LIMIT 1
        `
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  updateDisplayName(displayName: string): StoredProfile {
    const profile = this.getProfile();
    if (!profile) throw new Error('Profile does not exist');
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'UPDATE profile SET display_name = ?, updated_at = ? WHERE id = ?',
      displayName,
      now,
      profile.id
    );
    return { ...profile, displayName, updatedAt: now };
  }

  createSession(input: {
    idHash: string;
    expiresAt: string;
    userAgent?: string;
    ipPrefix?: string;
  }): void {
    const profile = this.getProfile();
    if (!profile) throw new Error('Profile does not exist');
    this.ctx.storage.sql.exec(
      `
        INSERT INTO sessions (id_hash, user_id, expires_at, created_at, user_agent, ip_prefix)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.idHash,
      profile.id,
      input.expiresAt,
      new Date().toISOString(),
      input.userAgent ?? null,
      input.ipPrefix ?? null
    );
  }

  validateSession(input: { idHash: string; now: string }): AuthenticatedUser | null {
    const profile = this.getProfile();
    if (!profile) return null;
    const session = this.ctx.storage.sql
      .exec<SessionRow>(
        `
          SELECT id_hash, user_id, expires_at, created_at, user_agent, ip_prefix
          FROM sessions
          WHERE id_hash = ?
        `,
        input.idHash
      )
      .toArray()[0];
    if (!session || session.expires_at <= input.now) {
      if (session) {
        this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id_hash = ?', input.idHash);
      }
      return null;
    }
    return {
      userId: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      sessionId: session.id_hash
    };
  }

  revokeSession(idHash: string): void {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
  }

  createCliToken(input: { idHash: string; label: string; expiresAt: string }): void {
    const profile = this.getProfile();
    if (!profile) throw new Error('Profile does not exist');
    this.ctx.storage.sql.exec(
      `
        INSERT INTO cli_tokens (id_hash, label, expires_at, created_at, last_used_at)
        VALUES (?, ?, ?, ?, NULL)
      `,
      input.idHash,
      input.label,
      input.expiresAt,
      new Date().toISOString()
    );
  }

  validateCliToken(input: { idHash: string; now: string }): AuthenticatedUser | null {
    const profile = this.getProfile();
    if (!profile) return null;
    const row = this.ctx.storage.sql
      .exec<CliTokenRow>(
        `
          SELECT id_hash, label, expires_at, created_at, last_used_at
          FROM cli_tokens
          WHERE id_hash = ?
        `,
        input.idHash
      )
      .toArray()[0];
    if (!row || row.expires_at <= input.now) {
      if (row) this.ctx.storage.sql.exec('DELETE FROM cli_tokens WHERE id_hash = ?', input.idHash);
      return null;
    }
    this.ctx.storage.sql.exec(
      'UPDATE cli_tokens SET last_used_at = ? WHERE id_hash = ?',
      input.now,
      input.idHash
    );
    return {
      userId: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      sessionId: `cli:${row.id_hash}`
    };
  }

  revokeCliToken(idHash: string): void {
    this.ctx.storage.sql.exec('DELETE FROM cli_tokens WHERE id_hash = ?', idHash);
  }

  addServer(summary: ServerSummary): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        INSERT INTO servers (server_id, name, summary_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          name = excluded.name,
          summary_json = excluded.summary_json,
          updated_at = excluded.updated_at
      `,
      summary.id,
      summary.name,
      JSON.stringify(summary),
      now,
      now
    );
  }

  upsertServerSnapshot(snapshot: ServerControlSnapshot): void {
    this.addServer(snapshot.summary);
    this.ctx.storage.sql.exec(
      `
        INSERT INTO server_snapshots (server_id, snapshot_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `,
      snapshot.summary.id,
      JSON.stringify(snapshot),
      snapshot.updatedAt
    );
  }

  getServerSnapshot(serverId: string): ServerControlSnapshot | null {
    const row = this.ctx.storage.sql
      .exec<ServerSnapshotRow>(
        'SELECT server_id, snapshot_json, updated_at FROM server_snapshots WHERE server_id = ?',
        serverId
      )
      .toArray()[0];
    return row ? (JSON.parse(row.snapshot_json) as ServerControlSnapshot) : null;
  }

  removeServer(serverId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM servers WHERE server_id = ?', serverId);
    this.ctx.storage.sql.exec('DELETE FROM server_snapshots WHERE server_id = ?', serverId);
  }

  listServers(): ServerSummary[] {
    return this.ctx.storage.sql
      .exec<ServerRow>(
        'SELECT server_id, name, summary_json, created_at, updated_at FROM servers ORDER BY updated_at DESC'
      )
      .toArray()
      .map((row) => JSON.parse(row.summary_json) as ServerSummary);
  }
}
