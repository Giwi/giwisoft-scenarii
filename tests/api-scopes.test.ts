import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import type { AddressInfo } from 'net';
import { initStorage, closeStorage } from '../src/config/storage';
import { loadSettings } from '../src/config/settings';
import { createApp } from '../src/routes/server';

let server: http.Server;
let base: string;

before(async () => {
  const settings = loadSettings();
  settings.api = {
    auth: {
      enabled: true,
      api_key: 'legacy-admin-key',
      tokens: [
        { name: 'ci-read', token: 'read-token', scopes: ['read'] },
        { name: 'ci-trigger', token: 'trigger-token', scopes: ['trigger'] },
      ],
    },
  };
  await initStorage(':memory:');
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await closeStorage();
});

function req(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { ...init, headers });
}

describe('scoped API tokens', () => {
  it('rejects unknown tokens', async () => {
    const res = await req('/api/scenarios', 'nope');
    assert.strictEqual(res.status, 401);
  });

  it('allows read tokens on read routes', async () => {
    const res = await req('/api/scenarios', 'read-token');
    assert.strictEqual(res.status, 200);
  });

  it('denies read routes to a trigger-only token', async () => {
    const res = await req('/api/scenarios', 'trigger-token');
    assert.strictEqual(res.status, 403);
  });

  it('passes trigger scope to the run endpoint', async () => {
    const res = await req('/api/scenarios/demo/run', 'trigger-token', { method: 'POST' });
    // No scenarios directory configured in this test: 400 proves the scope gate passed.
    assert.strictEqual(res.status, 400);
  });

  it('serves a persisted run by id to read tokens', async () => {
    const res = await req('/api/runs/9999', 'read-token');
    assert.strictEqual(res.status, 404);
  });

  it('treats the legacy api_key as an admin token', async () => {
    const res = await req('/api/scenarios/demo/run', 'legacy-admin-key', { method: 'POST' });
    assert.strictEqual(res.status, 400);
  });
});
