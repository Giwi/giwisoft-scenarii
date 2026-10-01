import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { initStorage, closeStorage } from '../src/config/storage';
import { createUser, generatePassword } from '../src/config/users';
import { createApp } from '../src/routes/server';

// Minimal request helper against a running app instance on an ephemeral port.
import http from 'http';
import type { AddressInfo } from 'net';

let server: http.Server;
let base: string;
const adminPassword = generatePassword();
const userPassword = generatePassword();
let carolPassword = '';

// Logs in and returns the session cookie pair.
async function loginAs(username: string, password: string): Promise<string> {
  const res = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.strictEqual(res.status, 200, `login failed for ${username}`);
  return `scenarii-session=${res.headers.get('set-cookie')!.match(/scenarii-session=([^;]+)/)![1]}`;
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init });
}

before(async () => {
  initStorage(':memory:');
  createUser('admin', adminPassword, 'admin');
  createUser('bob', userPassword, 'user');
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  closeStorage();
});

describe('API authentication', () => {
  it('rejects API calls without a session', async () => {
    const res = await req('/api/scenarios');
    assert.strictEqual(res.status, 401);
  });

  it('reports the auth status as unauthenticated', async () => {
    const res = await req('/api/auth/me');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { authenticated: false, username: null, role: null, provider: 'local' });
  });

  it('rejects a wrong password', async () => {
    const res = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('rejects an unknown user', async () => {
    const res = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost', password: 'x' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('accepts valid credentials and sets a session cookie', async () => {
    const res = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { username: 'admin', role: 'admin', provider: 'local' });
    const cookie = res.headers.get('set-cookie')!;
    assert.match(cookie, /scenarii-session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  it('grants access with the session cookie', async () => {
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const me = await req('/api/auth/me', { headers: { cookie } });
    assert.deepStrictEqual(await me.json(), { authenticated: true, username: 'admin', role: 'admin', provider: 'local' });

    // /api/scenarios needs storage-backed data, so a non-401 proves the session passed.
    const scenarios = await req('/api/scenarios', { headers: { cookie } });
    assert.notStrictEqual(scenarios.status, 401);
  });

  it('rejects a bogus session cookie', async () => {
    const res = await req('/api/scenarios', { headers: { cookie: 'scenarii-session=deadbeef' } });
    assert.strictEqual(res.status, 401);
  });

  it('clears the cookie on logout', async () => {
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const out = await req('/api/auth/logout', { method: 'POST', headers: { cookie } });
    assert.strictEqual(out.status, 200);
    assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);

    const after = await req('/api/scenarios', { headers: { cookie } });
    assert.strictEqual(after.status, 401);
  });
});

describe('user management', () => {
  it('refuses anonymous access', async () => {
    assert.strictEqual((await req('/api/auth/users')).status, 401);
    assert.strictEqual((await req('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mallory' }),
    })).status, 401);
  });

  it('refuses plain users', async () => {
    const cookie = await loginAs('bob', userPassword);
    assert.strictEqual((await req('/api/auth/users', { headers: { cookie } })).status, 403);
    assert.strictEqual((await req('/api/auth/users', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mallory' }),
    })).status, 403);
  });

  it('lets an admin list users with their roles', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const res = await req('/api/auth/users', { headers: { cookie } });
    assert.strictEqual(res.status, 200);
    const { users } = await res.json() as { users: { username: string; role: string }[] };
    assert.deepStrictEqual(users.find(u => u.username === 'admin')?.role, 'admin');
    assert.deepStrictEqual(users.find(u => u.username === 'bob')?.role, 'user');
  });

  it('lets an admin add a user, generating the password once', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const res = await req('/api/auth/users', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol' }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json() as { username: string; role: string; generated_password: string };
    assert.strictEqual(body.username, 'carol');
    assert.strictEqual(body.role, 'user');
    assert.strictEqual(body.generated_password.length, 24);
    carolPassword = body.generated_password;

    // The generated password is usable for login.
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: carolPassword }),
    });
    assert.strictEqual(login.status, 200);
  });

  it('rejects duplicates and missing usernames', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const post = (body: unknown) => req('/api/auth/users', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.strictEqual((await post({ username: 'carol' })).status, 409);
    assert.strictEqual((await post({})).status, 400);
  });

  it('lets an admin change a role and a password', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const role = await req('/api/auth/users/role', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', role: 'admin' }),
    });
    assert.strictEqual(role.status, 200);

    // The promoted user can now manage users.
    const carolCookie = await loginAs('carol', carolPassword);
    assert.strictEqual((await req('/api/auth/users', { headers: { cookie: carolCookie } })).status, 200);

    const passwd = await req('/api/auth/users/password', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'new-bob-pw' }),
    });
    assert.strictEqual(passwd.status, 200);
    assert.deepStrictEqual(await passwd.json(), { status: 'updated' });
    assert.strictEqual((await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: userPassword }),
    })).status, 401);
    assert.strictEqual((await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'new-bob-pw' }),
    })).status, 200);
  });

  it('generates a password on reset when none is supplied', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const res = await req('/api/auth/users/password', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.strictEqual(res.status, 200);
    const { generated_password } = await res.json() as { generated_password: string };
    assert.strictEqual(generated_password.length, 24);
    assert.strictEqual((await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: generated_password }),
    })).status, 200);
  });

  it('protects the last admin and deletes other users', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const del = (username: string, ck = cookie) => req(`/api/auth/users/${username}`, { method: 'DELETE', headers: { cookie: ck } });
    const role = (username: string, value: string) => req('/api/auth/users/role', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, role: value }),
    });

    // An admin cannot lock themselves out.
    assert.strictEqual((await del('admin')).status, 400);
    assert.strictEqual((await role('admin', 'user')).status, 400);

    // Demote carol: admin becomes the only admin left, so the others are still deletable.
    assert.strictEqual((await role('carol', 'user')).status, 200);
    assert.strictEqual((await del('ghost')).status, 404);
    assert.strictEqual((await del('carol')).status, 200);
    assert.strictEqual((await del('carol')).status, 404);

    // With a second admin present, deleting one of them is allowed.
    const made = await req('/api/auth/users', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dave', role: 'admin' }),
    });
    assert.strictEqual(made.status, 201);
    const daveCookie = await loginAs('dave', (await made.json() as { generated_password: string }).generated_password);
    assert.strictEqual((await del('dave', daveCookie)).status, 400); // own account
    assert.strictEqual((await del('dave')).status, 200);
  });
});

describe('public endpoints', () => {
  it('leaves health, status, and auth endpoints open', async () => {
    assert.strictEqual((await req('/api/health')).status, 200);
    assert.strictEqual((await req('/api/status')).status, 200);
    assert.strictEqual((await req('/api/auth/me')).status, 200);
  });
});

describe('page authentication', () => {
  it('redirects anonymous visitors to the login page', async () => {
    const res = await req('/');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login?next=%2F');
  });

  it('redirects private sub-pages, preserving the target', async () => {
    const res = await req('/scenario/my-scenario');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login?next=%2Fscenario%2Fmy-scenario');
  });

  it('serves the login page itself', async () => {
    const res = await req('/login');
    assert.notStrictEqual(res.status, 302);
  });

  it('lets authenticated users through to the SPA', async () => {
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await req('/scenario/my-scenario', { headers: { cookie } });
    assert.notStrictEqual(res.status, 302);
  });
});
