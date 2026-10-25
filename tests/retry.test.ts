import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { fetchWithRetry, postJson, NOTIFICATION_RETRIES } from '../src/utils/retry';

describe('fetchWithRetry', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns response on first success', async () => {
    global.fetch = async () => new Response('ok', { status: 200 });
    const res = await fetchWithRetry('http://example.com', {});
    assert.strictEqual(res.status, 200);
  });

  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    global.fetch = async () => {
      attempts++;
      if (attempts < 3) return new Response('fail', { status: 500 });
      return new Response('ok', { status: 200 });
    };
    const res = await fetchWithRetry('http://example.com', {}, 3);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(attempts, 3);
  });

  it('returns last response when all retries exhausted', async () => {
    global.fetch = async () => new Response('fail', { status: 500 });
    const res = await fetchWithRetry('http://example.com', {}, 3);
    assert.strictEqual(res.status, 500);
  });
});

describe('postJson', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves when the endpoint accepts the payload', async () => {
    global.fetch = async () => new Response('ok', { status: 200 });
    await postJson('http://example.com', { hello: 'world' }, 'Test', 1);
  });

  it('throws when the endpoint rejects the payload', async () => {
    global.fetch = async () => new Response('bad request', { status: 400 });
    await assert.rejects(
      () => postJson('http://example.com', { hello: 'world' }, 'Test', 1),
      /Test notification failed: 400 bad request/,
    );
  });
});
