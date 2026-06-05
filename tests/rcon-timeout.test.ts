import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeRcon } from '../src/worker/minecraft/rcon.ts';

describe('RCON timeout', () => {
  it('bounds reads after the socket opens', async () => {
    let closed = false;
    const socket = {
      opened: Promise.resolve(),
      readable: new ReadableStream({
        start() {
          // Keep the stream open without sending an auth response.
        }
      }),
      writable: new WritableStream(),
      close: async () => {
        closed = true;
      }
    } as unknown as Socket;

    const tcpPort = {
      connect() {
        return socket;
      }
    };

    await assert.rejects(
      executeRcon(tcpPort, 'password', 'list', { timeoutMs: 20 }),
      /RCON timed out/
    );
    assert.equal(closed, true);
  });
});
