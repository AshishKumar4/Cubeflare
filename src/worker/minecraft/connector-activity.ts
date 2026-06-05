export type ConnectorActivitySession = {
  activeBridgeConnections: number;
  expiresAt: string;
};

export type ConnectorActivitySessions = Record<string, ConnectorActivitySession>;

export type ConnectorActivitySnapshot = {
  sessions: ConnectorActivitySessions;
  activeBridgeConnections: number;
  changed: boolean;
};

export function updateConnectorActivitySessions(
  current: ConnectorActivitySessions | null | undefined,
  input: {
    sessionId: string;
    activeBridgeConnections: number;
    ttlSeconds: number;
    nowMs: number;
  }
): ConnectorActivitySnapshot {
  const pruned = summarizeConnectorActivitySessions(current, input.nowMs);
  const sessionId = cleanConnectorSessionId(input.sessionId);
  const activeBridgeConnections = cleanActiveBridgeConnections(input.activeBridgeConnections);
  const sessions: ConnectorActivitySessions = { ...pruned.sessions };
  let changed = pruned.changed;

  if (sessionId && activeBridgeConnections > 0) {
    sessions[sessionId] = {
      activeBridgeConnections,
      expiresAt: new Date(input.nowMs + cleanTtlSeconds(input.ttlSeconds) * 1000).toISOString()
    };
    changed = true;
  } else if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
    changed = true;
  }

  return {
    sessions,
    activeBridgeConnections: aggregateActiveBridgeConnections(sessions),
    changed
  };
}

export function summarizeConnectorActivitySessions(
  current: ConnectorActivitySessions | null | undefined,
  nowMs: number
): ConnectorActivitySnapshot {
  const sessions: ConnectorActivitySessions = {};
  let changed = false;

  for (const [sessionId, session] of Object.entries(current ?? {})) {
    const cleanSessionId = cleanConnectorSessionId(sessionId);
    const activeBridgeConnections = cleanActiveBridgeConnections(session.activeBridgeConnections);
    const expiresAtMs = Date.parse(session.expiresAt);
    if (
      !cleanSessionId ||
      activeBridgeConnections <= 0 ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= nowMs
    ) {
      changed = true;
      continue;
    }

    sessions[cleanSessionId] = {
      activeBridgeConnections,
      expiresAt: session.expiresAt
    };
    if (cleanSessionId !== sessionId || activeBridgeConnections !== session.activeBridgeConnections) {
      changed = true;
    }
  }

  return {
    sessions,
    activeBridgeConnections: aggregateActiveBridgeConnections(sessions),
    changed
  };
}

function aggregateActiveBridgeConnections(sessions: ConnectorActivitySessions): number {
  return Object.values(sessions).reduce(
    (sum, session) => sum + cleanActiveBridgeConnections(session.activeBridgeConnections),
    0
  );
}

function cleanConnectorSessionId(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : '';
}

function cleanTtlSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.trunc(value), 86_400);
}

function cleanActiveBridgeConnections(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.trunc(parsed), 10_000);
}
