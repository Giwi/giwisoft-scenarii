import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import type { AddressInfo } from 'net';
import { initStorage, closeStorage } from '../src/config/storage';
import { getSettings, loadSettings } from '../src/config/settings';
import { createUser, generatePassword, setProfile } from '../src/config/users';
import { createApp } from '../src/routes/server';

// Auth disabled: requests have no session but act as the default user. The status endpoint
// must still expose that user's saved preferences, otherwise the profile page reloads its
// status after a save and the interface falls back to default language/theme.
let server: http.Server;
let base: string;

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init });
}

before(async () => {
  await initStorage(':memory:');
  await createUser('admin', generatePassword(), 'admin');
  await setProfile('admin', { lang: 'fr', color_scheme: 'dark' });
  loadSettings();
  getSettings().auth = { enabled: false, default_user: 'admin', default_user_role: 'admin' };
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await closeStorage();
});

describe('auth disabled', () => {
  it('reports the default user with its saved preferences', async () => {
    const res = await req('/api/auth/me');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {
      authenticated: true,
      username: 'admin',
      role: 'admin',
      provider: null,
      lang: 'fr',
      color_scheme: 'dark',
      avatar_url: null,
    });
  });

  it('keeps profile changes after the status is reloaded', async () => {
    const saved = await req('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'en', color_scheme: 'light' }),
    });
    assert.strictEqual(saved.status, 200);

    const me = await req('/api/auth/me');
    const status = await me.json() as { lang: string; color_scheme: string };
    assert.strictEqual(status.lang, 'en');
    assert.strictEqual(status.color_scheme, 'light');
  });
});
