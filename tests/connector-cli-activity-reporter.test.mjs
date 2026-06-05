import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActivityReporter } from '../bin/cubeflare.mjs';

describe('connector CLI activity reporter', () => {
  it('waits for the final zero-activity report before shutdown completes', async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      requests.push(body);
      if (body.activeConnections === 0) await delay(25);
      return new Response('{}', { status: 200 });
    };

    try {
      const activity = createActivityReporter({
        origin: 'https://minecraft.example.test',
        token: 'activity-token'
      });

      const release = activity.acquire();
      await waitFor(() => requests.some((request) => request.activeConnections === 1));

      release();
      await activity.close();

      assert.deepEqual(
        requests.map((request) => request.activeConnections),
        [1, 0]
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('condition was not met');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
