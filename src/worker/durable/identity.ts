import { DurableObject } from 'cloudflare:workers';
import type { AppEnv } from '../types';

type IdentityRow = {
  email: string;
  user_id: string;
  created_at: string;
};

type CliAuthRow = {
  device_hash: string;
  user_code: string;
  device_name: string;
  expires_at: string;
  approved_user_id: string | null;
  approved_at: string | null;
  consumed_at: string | null;
  created_at: string;
};

type ServerInviteRow = {
  code_hash: string;
  server_id: string;
  owner_id: string;
  host: string;
  kind: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  last_used_at: string | null;
  use_count: number;
};

export type CliAuthRequestStatus =
  | { status: 'pending'; expiresAt: string }
  | { status: 'approved'; userId: string; deviceName: string; expiresAt: string }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'missing' };

export class IdentityRegistryDO extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS identities (
          email TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cli_auth_requests (
          device_hash TEXT PRIMARY KEY,
          user_code TEXT NOT NULL UNIQUE,
          device_name TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          approved_user_id TEXT,
          approved_at TEXT,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_invites (
          code_hash TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          host TEXT NOT NULL,
          kind TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disabled_at TEXT,
          last_used_at TEXT,
          use_count INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.ensureServerInviteSchema();
    });
  }

  private ensureServerInviteSchema(): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string; notnull: number }>('PRAGMA table_info(server_invites)')
      .toArray();
    const columnNames = new Set(columns.map((column) => column.name));
    const expiresAt = columns.find((column) => column.name === 'expires_at');
    const needsRecreate =
      !columnNames.has('kind') ||
      !columnNames.has('updated_at') ||
      !columnNames.has('disabled_at') ||
      Boolean(expiresAt?.notnull);
    if (needsRecreate) {
      this.ctx.storage.sql.exec('DROP TABLE IF EXISTS server_invites');
      this.ctx.storage.sql.exec(`
        CREATE TABLE server_invites (
          code_hash TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          host TEXT NOT NULL,
          kind TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disabled_at TEXT,
          last_used_at TEXT,
          use_count INTEGER NOT NULL DEFAULT 0
        )
      `);
    }
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS server_invites_server_kind_idx ON server_invites (server_id, owner_id, kind)'
    );
  }

  reserveEmail(email: string, userId: string): { ok: true } | { ok: false; userId: string } {
    const existing = this.lookup(email);
    if (existing) {
      return { ok: false, userId: existing.userId };
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO identities (email, user_id, created_at) VALUES (?, ?, ?)',
      email,
      userId,
      new Date().toISOString()
    );
    return { ok: true };
  }

  lookup(email: string): { email: string; userId: string; createdAt: string } | null {
    const row = this.ctx.storage.sql
      .exec<IdentityRow>('SELECT email, user_id, created_at FROM identities WHERE email = ?', email)
      .toArray()[0];
    if (!row) return null;
    return {
      email: row.email,
      userId: row.user_id,
      createdAt: row.created_at
    };
  }

  createCliAuthRequest(input: {
    deviceHash: string;
    userCode: string;
    deviceName: string;
    expiresAt: string;
  }): { ok: true } | { ok: false } {
    this.ctx.storage.sql.exec(
      'DELETE FROM cli_auth_requests WHERE expires_at <= ? OR consumed_at IS NOT NULL',
      new Date().toISOString()
    );
    try {
      this.ctx.storage.sql.exec(
        `
          INSERT INTO cli_auth_requests (
            device_hash, user_code, device_name, expires_at, approved_user_id,
            approved_at, consumed_at, created_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
        `,
        input.deviceHash,
        input.userCode,
        input.deviceName,
        input.expiresAt,
        new Date().toISOString()
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  approveCliAuthRequest(input: {
    userCode: string;
    userId: string;
    now: string;
  }): CliAuthRequestStatus {
    const row = this.getCliAuthByUserCode(input.userCode);
    if (!row) return { status: 'missing' };
    if (row.consumed_at) return { status: 'consumed' };
    if (row.expires_at <= input.now) return { status: 'expired' };

    const approvedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE cli_auth_requests
        SET approved_user_id = ?, approved_at = ?
        WHERE user_code = ?
      `,
      input.userId,
      approvedAt,
      input.userCode
    );
    return {
      status: 'approved',
      userId: input.userId,
      deviceName: row.device_name,
      expiresAt: row.expires_at
    };
  }

  consumeCliAuthRequest(input: { deviceHash: string; now: string }): CliAuthRequestStatus {
    const row = this.getCliAuthByDeviceHash(input.deviceHash);
    if (!row) return { status: 'missing' };
    if (row.consumed_at) return { status: 'consumed' };
    if (row.expires_at <= input.now) return { status: 'expired' };
    if (!row.approved_user_id) {
      return { status: 'pending', expiresAt: row.expires_at };
    }

    this.ctx.storage.sql.exec(
      'UPDATE cli_auth_requests SET consumed_at = ? WHERE device_hash = ?',
      new Date().toISOString(),
      input.deviceHash
    );
    return {
      status: 'approved',
      userId: row.approved_user_id,
      deviceName: row.device_name,
      expiresAt: row.expires_at
    };
  }

  private getCliAuthByUserCode(userCode: string): CliAuthRow | null {
    return (
      this.ctx.storage.sql
        .exec<CliAuthRow>(
          `
            SELECT device_hash, user_code, device_name, expires_at, approved_user_id,
              approved_at, consumed_at, created_at
            FROM cli_auth_requests
            WHERE user_code = ?
          `,
          userCode
        )
        .toArray()[0] ?? null
    );
  }

  private getCliAuthByDeviceHash(deviceHash: string): CliAuthRow | null {
    return (
      this.ctx.storage.sql
        .exec<CliAuthRow>(
          `
            SELECT device_hash, user_code, device_name, expires_at, approved_user_id,
              approved_at, consumed_at, created_at
            FROM cli_auth_requests
            WHERE device_hash = ?
          `,
          deviceHash
        )
        .toArray()[0] ?? null
    );
  }

  upsertServerInvite(input: {
    codeHash: string;
    serverId: string;
    ownerId: string;
    host: string;
    kind: 'primary';
    expiresAt?: string | null;
  }): { ok: true } | { ok: false } {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec('DELETE FROM server_invites WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
    try {
      this.ctx.storage.sql.exec(
        'DELETE FROM server_invites WHERE server_id = ? AND owner_id = ? AND kind = ?',
        input.serverId,
        input.ownerId,
        input.kind
      );
      this.ctx.storage.sql.exec(
        `
          INSERT INTO server_invites (
            code_hash, server_id, owner_id, host, kind, expires_at, created_at,
            updated_at, disabled_at, last_used_at, use_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
        `,
        input.codeHash,
        input.serverId,
        input.ownerId,
        input.host,
        input.kind,
        input.expiresAt ?? null,
        now,
        now
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  resolveServerInvite(input: {
    codeHash: string;
    now: string;
    touch?: boolean;
  }): {
    serverId: string;
    ownerId: string;
    host: string;
    kind: string;
    expiresAt: string | null;
  } | null {
    const row = this.ctx.storage.sql
      .exec<ServerInviteRow>(
        `
          SELECT code_hash, server_id, owner_id, host, kind, expires_at, created_at,
            updated_at, disabled_at, last_used_at, use_count
          FROM server_invites
          WHERE code_hash = ?
        `,
        input.codeHash
      )
      .toArray()[0];
    if (!row || row.disabled_at) return null;
    if (row.expires_at && row.expires_at <= input.now) {
      this.ctx.storage.sql.exec('DELETE FROM server_invites WHERE code_hash = ?', input.codeHash);
      return null;
    }
    if (input.touch) {
      this.ctx.storage.sql.exec(
        'UPDATE server_invites SET last_used_at = ?, use_count = use_count + 1 WHERE code_hash = ?',
        input.now,
        input.codeHash
      );
    }
    return {
      serverId: row.server_id,
      ownerId: row.owner_id,
      host: row.host,
      kind: row.kind,
      expiresAt: row.expires_at
    };
  }

  removeServerInvites(input: { serverId: string; ownerId: string }): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM server_invites WHERE server_id = ? AND owner_id = ?',
      input.serverId,
      input.ownerId
    );
  }
}
