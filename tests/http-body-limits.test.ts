import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError, parseJson } from '../src/worker/http.ts';

describe('HTTP body limits', () => {
  it('rejects JSON bodies over the configured limit', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'abcdef' })
    });

    await assert.rejects(
      () => parseJson(request, { maxBytes: 8 }),
      (error) => error instanceof HttpError && error.status === 413 && error.code === 'body_too_large'
    );
  });

  it('parses JSON bodies inside the configured limit', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    });

    assert.deepEqual(await parseJson(request, { maxBytes: 32 }), { ok: true });
  });
});
