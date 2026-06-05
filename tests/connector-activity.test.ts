import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  summarizeConnectorActivitySessions,
  updateConnectorActivitySessions
} from '../src/worker/minecraft/connector-activity.ts';

describe('connector activity aggregation', () => {
  it('aggregates multiple connector sessions instead of overwriting the server count', () => {
    const nowMs = Date.parse('2026-06-04T20:00:00.000Z');
    const first = updateConnectorActivitySessions(null, {
      sessionId: 'ownerSession_1',
      activeBridgeConnections: 1,
      ttlSeconds: 900,
      nowMs
    });
    const second = updateConnectorActivitySessions(first.sessions, {
      sessionId: 'friendSession_2',
      activeBridgeConnections: 2,
      ttlSeconds: 900,
      nowMs
    });

    assert.equal(second.activeBridgeConnections, 3);
    assert.equal(second.sessions.ownerSession_1.activeBridgeConnections, 1);
    assert.equal(second.sessions.friendSession_2.activeBridgeConnections, 2);
  });

  it('removes only the connector session that reports zero bridge connections', () => {
    const nowMs = Date.parse('2026-06-04T20:00:00.000Z');
    const active = updateConnectorActivitySessions(null, {
      sessionId: 'ownerSession_1',
      activeBridgeConnections: 1,
      ttlSeconds: 900,
      nowMs
    });
    const withFriend = updateConnectorActivitySessions(active.sessions, {
      sessionId: 'friendSession_2',
      activeBridgeConnections: 1,
      ttlSeconds: 900,
      nowMs
    });
    const afterOwnerLeaves = updateConnectorActivitySessions(withFriend.sessions, {
      sessionId: 'ownerSession_1',
      activeBridgeConnections: 0,
      ttlSeconds: 900,
      nowMs
    });

    assert.equal(afterOwnerLeaves.activeBridgeConnections, 1);
    assert.deepEqual(Object.keys(afterOwnerLeaves.sessions), ['friendSession_2']);
  });

  it('expires stale connector sessions before lifecycle policy sees activity', () => {
    const nowMs = Date.parse('2026-06-04T20:00:00.000Z');
    const active = updateConnectorActivitySessions(null, {
      sessionId: 'friendSession_2',
      activeBridgeConnections: 1,
      ttlSeconds: 60,
      nowMs
    });
    const expired = summarizeConnectorActivitySessions(active.sessions, nowMs + 61_000);

    assert.equal(expired.activeBridgeConnections, 0);
    assert.equal(expired.changed, true);
    assert.deepEqual(expired.sessions, {});
  });
});
