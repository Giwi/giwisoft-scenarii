import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStorage, closeStorage } from '../src/config/storage';
import { loadSettings, reloadSettings } from '../src/config/settings';
import { oidcManaged } from '../src/routes/profile';
import {
  createUser, generatePassword, getProfile, createPasswordReset, setPassword,
} from '../src/config/users';
import { currentTotpCode, generateTotpSecret, totpUri, verifyTotp, base32Decode, base32Encode } from '../src/utils/totp';
import { gravatarUrl, decodeDataUrl, isValidEmail } from '../src/config/avatar';
import { isComplete, LANGS, messageIds, normalizeLang, langFromAcceptLanguage, t } from '../src/i18n';
import { createApp } from '../src/routes/server';
import http from 'http';
import type { AddressInfo } from 'net';

let server: http.Server;
let base: string;
const adminPassword = generatePassword();
const bobPassword = generatePassword();

// 1x1 transparent PNG, the smallest payload an avatar upload can carry.
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init });
}

// POST helper that keeps Content-Type when a cookie header is added: dropping it means
// the body is never parsed and the handler sees no payload at all.
function json(body: unknown, cookie?: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  };
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await req('/api/auth/login', json({ username, password }));
  assert.strictEqual(res.status, 200, `login failed for ${username}`);
  const body = await res.json() as { requires_2fa?: boolean; challenge?: string };
  assert.ok(!body.requires_2fa, `${username} unexpectedly needs a second factor`);
  return `scenarii-session=${res.headers.get('set-cookie')!.match(/scenarii-session=([^;]+)/)![1]}`;
}

// Turns on TOTP for a user by walking the real setup endpoints.
async function enableTotpFor(cookie: string, username: string): Promise<{ secret: string; recovery: string[] }> {
  const setup = await req('/api/profile/totp/setup', json({}, cookie));
  assert.strictEqual(setup.status, 200);
  const { secret } = await setup.json() as { secret: string };
  const enable = await req('/api/profile/totp/enable', json({ code: currentTotpCode(secret) }, cookie));
  assert.strictEqual(enable.status, 200, `2FA enable failed for ${username}`);
  const { recovery_codes } = await enable.json() as { recovery_codes: string[] };
  return { secret, recovery: recovery_codes };
}

before(async () => {
  initStorage(':memory:');
  createUser('admin', adminPassword, 'admin');
  createUser('bob', bobPassword, 'user');
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  closeStorage();
});

describe('TOTP primitives', () => {
  it('round-trips base32 secrets', () => {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    assert.deepStrictEqual(base32Decode(base32Encode(bytes)), bytes);
    // Decoding is tolerant of how an app displays the secret (lowercase, spaced).
    const encoded = base32Encode(crypto.randomBytes(20));
    assert.deepStrictEqual(base32Decode(`${encoded.slice(0, 8).toLowerCase()} ${encoded.slice(8)}`), base32Decode(encoded));
  });

  it('matches the RFC 6238 SHA-1 test vectors', () => {
    // The RFC secret is "12345678901234567890", base32 of it is below. RFC 6238 publishes
    // 8 digit codes; authenticator apps use the last 6 digits of the same truncated value.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.strictEqual(currentTotpCode(secret, 59_000), '287082'); // 94287082
    assert.strictEqual(currentTotpCode(secret, 1_111_111_109_000), '081804'); // 07081804
    assert.strictEqual(currentTotpCode(secret, 1_234_567_890_000), '005924'); // 89005924
  });

  it('accepts a current code and rejects a wrong one', () => {
    const secret = generateTotpSecret();
    assert.ok(verifyTotp(secret, currentTotpCode(secret)));
    assert.ok(!verifyTotp(secret, currentTotpCode(secret, Date.now() - 10 * 60_000)), 'expired code accepted');
    assert.ok(!verifyTotp(secret, '123'));
    assert.ok(!verifyTotp(secret, 'abcdef'));
    assert.ok(!verifyTotp('', currentTotpCode(secret)));
  });

  it('generates an otpauth:// URI an authenticator app can import', () => {
    const secret = generateTotpSecret();
    const uri = totpUri(secret, 'alice');
    assert.ok(uri.startsWith('otpauth://totp/'));
    assert.ok(uri.includes(`secret=${secret}`));
    assert.ok(uri.includes('issuer=Scenarii'));
    assert.ok(uri.includes('digits=6'));
  });

  it('issues distinct secrets', () => {
    assert.notStrictEqual(generateTotpSecret(), generateTotpSecret());
  });
});

describe('Message catalogue', () => {
  it('is complete for every supported language', () => {
    for (const lang of LANGS) assert.ok(isComplete(lang), `${lang} is missing messages`);
  });

  it('falls back to English, then to the key itself', () => {
    assert.strictEqual(t('auth.invalid_credentials', 'fr'), 'Identifiant ou mot de passe incorrect');
    assert.strictEqual(t('does.not.exist', 'fr'), 'does.not.exist');
  });

  it('interpolates parameters', () => {
    assert.strictEqual(t('users.delete_confirm', 'en', { name: 'bob' }), 'Delete user bob?');
    assert.ok(messageIds().includes('auth.invalid_credentials'));
  });

  it('normalises and negotiates languages', () => {
    assert.strictEqual(normalizeLang('de'), 'de');
    assert.strictEqual(normalizeLang('klingon'), 'en');
    assert.strictEqual(langFromAcceptLanguage('fr-FR,fr;q=0.9,en;q=0.8'), 'fr');
    assert.strictEqual(langFromAcceptLanguage('de;q=0.2,es;q=0.9'), 'es');
    assert.strictEqual(langFromAcceptLanguage(undefined), 'en');
  });
});

describe('Profile', () => {
  it('serves the session user profile and defaults to Gravatar-less state', async () => {
    const cookie = await loginAs('bob', bobPassword);
    const res = await req('/api/profile', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.strictEqual(body.username, 'bob');
    assert.strictEqual(body.email, null);
    assert.strictEqual(body.has_avatar, false);
    // No upload and no email: nothing to render, so the profile carries a null URL.
    assert.strictEqual(body.avatar_url, null);
    assert.strictEqual(body.totp_available, true);
  });

  it('updates email, language and colour scheme', async () => {
    const cookie = await loginAs('bob', bobPassword);
    const res = await req('/api/profile', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', lang: 'fr', color_scheme: 'dark' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.strictEqual(body.email, 'bob@example.com');
    assert.strictEqual(body.lang, 'fr');
    assert.strictEqual(body.color_scheme, 'dark');
    // An email gives the profile a Gravatar default.
    assert.match(String(body.avatar_url), /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}/);
  });

  it('rejects a malformed email and accepts clearing it', async () => {
    const cookie = await loginAs('bob', bobPassword);
    const bad = await req('/api/profile', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.strictEqual(bad.status, 400);
    const cleared = await req('/api/profile', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '' }),
    });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual((await cleared.json() as { email: string | null }).email, null);
  });

  it('translates profile errors using the requested language', async () => {
    const res = await req('/api/profile', {
      method: 'PUT',
      headers: { 'Accept-Language': 'fr', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nope' }),
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json() as { error: string }).error, 'Authentification requise');
  });

  it('requires a session', async () => {
    assert.strictEqual((await req('/api/profile')).status, 401);
  });
});

describe('Avatar', () => {
  it('builds Gravatar URLs from the lowercased email', () => {
    const url = gravatarUrl('  Bob@Example.COM ');
    assert.strictEqual(url, `https://www.gravatar.com/avatar/${md5('bob@example.com')}?s=96&d=identicon`);
    assert.strictEqual(gravatarUrl(null), undefined);
  });

  it('accepts supported images and rejects the rest', () => {
    assert.ok(decodeDataUrl(`data:image/png;base64,${PNG_PIXEL}`));
    assert.strictEqual(decodeDataUrl('data:image/gif;base64,R0lGODlh'), null);
    assert.strictEqual(decodeDataUrl('not-a-data-url'), null);
    assert.strictEqual(decodeDataUrl(undefined), null);
  });

  it('validates emails', () => {
    assert.ok(isValidEmail('a@b.co'));
    assert.ok(!isValidEmail('a@b'));
    assert.ok(!isValidEmail('a b@c.co'));
  });

  it('stores, serves and removes an uploaded avatar', async () => {
    const cookie = await loginAs('bob', bobPassword);
    const up = await req('/api/profile/avatar', json({ image: `data:image/png;base64,${PNG_PIXEL}` }, cookie));
    assert.strictEqual(up.status, 200);
    assert.match(String((await up.json() as { avatar_url: string }).avatar_url), /^\/api\/profile\/avatar\/bob/);

    const file = await req('/api/profile/avatar/bob');
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.headers.get('content-type'), 'image/png');
    assert.strictEqual(Buffer.from(await file.arrayBuffer()).length, Buffer.from(PNG_PIXEL, 'base64').length);

    const del = await req('/api/profile/avatar', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await req('/api/profile/avatar/bob')).status, 404);
  });

  it('rejects an unsupported image format', async () => {
    const cookie = await loginAs('bob', bobPassword);
    const res = await req('/api/profile/avatar', json({ image: 'data:image/gif;base64,R0lGODlh' }, cookie));
    assert.strictEqual(res.status, 400);
    // Bob's profile language is fr (set above), so the API error comes back translated.
    assert.strictEqual((await res.json() as { error: string }).error, "Format d'image non pris en charge");
  });
});

describe('Password change', () => {
  it('requires the current password and a long enough new one', async () => {
    const cookie = await loginAs('bob', bobPassword);
    const short = await req('/api/profile/password', json({ current_password: bobPassword, new_password: 'short' }, cookie));
    assert.strictEqual(short.status, 400);
    const wrong = await req('/api/profile/password', json({ current_password: 'nope', new_password: 'a-long-enough-password' }, cookie));
    assert.strictEqual(wrong.status, 400);
    const ok = await req('/api/profile/password', json({ current_password: bobPassword, new_password: 'a-long-enough-password' }, cookie));
    assert.strictEqual(ok.status, 200);
    // The old password no longer works, the new one does.
    assert.strictEqual((await req('/api/auth/login', json({ username: 'bob', password: bobPassword }))).status, 401);
    await loginAs('bob', 'a-long-enough-password');
    setPassword('bob', bobPassword);
  });
});

describe('Password recovery', () => {
  it('answers identically for known and unknown identifiers', async () => {
    const known = await req('/api/auth/password/forgot', json({ identifier: 'admin' }));
    const unknown = await req('/api/auth/password/forgot', json({ identifier: 'nobody-at-all' }));
    assert.strictEqual(known.status, 200);
    assert.strictEqual(unknown.status, 200);
    assert.deepStrictEqual(await known.json(), await unknown.json());
  });

  it('finds a user by email address', async () => {
    const cookie = await loginAs('bob', bobPassword);
    await req('/api/profile', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com' }),
    });
    const token = createPasswordReset('bob');
    const res = await req('/api/auth/password/reset', json({ token, password: 'brand-new-password' }));
    assert.strictEqual(res.status, 200);
    await loginAs('bob', 'brand-new-password');
  });

  it('rejects an unknown or reused token', async () => {
    const bad = await req('/api/auth/password/reset', json({ token: 'nope', password: 'whatever-long' }));
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json() as { error: string }).error, 'This recovery link is invalid or has expired');

    const token = createPasswordReset('bob');
    assert.strictEqual((await req('/api/auth/password/reset', json({ token, password: 'first-password' }))).status, 200);
    // Single use: the second attempt with the same token fails.
    assert.strictEqual((await req('/api/auth/password/reset', json({ token, password: 'second-password' }))).status, 400);
    await loginAs('bob', 'first-password');
  });

  it('rejects a too short password', async () => {
    const token = createPasswordReset('bob');
    const res = await req('/api/auth/password/reset', json({ token, password: 'tiny' }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json() as { error: string }).error, 'Password must be at least 8 characters');
  });
});

describe('Two-factor authentication', () => {
  it('walks setup, enable, login challenge and disable', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const { secret, recovery } = await enableTotpFor(cookie, 'admin');
    assert.strictEqual(recovery.length, 10);
    assert.ok(getProfile('admin').totp_enabled);

    // Login now needs a second step.
    const first = await req('/api/auth/login', json({ username: 'admin', password: adminPassword }));
    assert.strictEqual(first.status, 200);
    const { requires_2fa, challenge } = await first.json() as { requires_2fa: boolean; challenge: string };
    assert.strictEqual(requires_2fa, true);
    assert.ok(challenge);

    const wrong = await req('/api/auth/login/2fa', json({ challenge, code: '000001' }));
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual((await wrong.json() as { error: string }).error, 'Invalid two-factor code');

    const good = await req('/api/auth/login/2fa', json({ challenge, code: currentTotpCode(secret) }));
    assert.strictEqual(good.status, 200);
    assert.ok(good.headers.get('set-cookie')?.includes('scenarii-session='));
    // A challenge cannot be replayed.
    assert.strictEqual((await req('/api/auth/login/2fa', json({ challenge, code: currentTotpCode(secret) }))).status, 400);

    // Disabling needs the password and a valid code.
    const noCode = await req('/api/profile/totp/disable', json({ password: adminPassword, code: '' }, cookie));
    assert.strictEqual(noCode.status, 400);
    const off = await req('/api/profile/totp/disable', json({ password: adminPassword, code: currentTotpCode(secret) }, cookie));
    assert.strictEqual(off.status, 200);
    assert.ok(!getProfile('admin').totp_enabled);
  });

  it('accepts a recovery code at login and burns it', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const { recovery } = await enableTotpFor(cookie, 'admin');
    const first = await req('/api/auth/login', json({ username: 'admin', password: adminPassword }));
    const { challenge } = await first.json() as { challenge: string };
    const ok = await req('/api/auth/login/2fa', json({ challenge, code: recovery[0] }));
    assert.strictEqual(ok.status, 200);

    const second = await req('/api/auth/login', json({ username: 'admin', password: adminPassword }));
    const { challenge: again } = await second.json() as { challenge: string };
    assert.strictEqual((await req('/api/auth/login/2fa', json({ challenge: again, code: recovery[0] }))).status, 401);

    // Leave 2FA off for the remaining tests.
    const off = await req('/api/profile/totp/disable', json({ password: adminPassword, code: recovery[1] }, cookie));
    assert.strictEqual(off.status, 200);
  });

  it('keeps the pending secret and enables 2FA once the code is right', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const setup = await req('/api/profile/totp/setup', json({}, cookie));
    const { secret } = await setup.json() as { secret: string };
    const bad = await req('/api/profile/totp/enable', json({ code: '111111' }, cookie));
    assert.strictEqual(bad.status, 400);
    assert.ok(!getProfile('admin').totp_enabled);
    // A wrong code must not destroy the setup: the same secret confirms right after.
    const good = await req('/api/profile/totp/enable', json({ code: currentTotpCode(secret) }, cookie));
    assert.strictEqual(good.status, 200);
    const { recovery_codes } = await good.json() as { recovery_codes: string[] };
    assert.ok(getProfile('admin').totp_enabled);
    // Clean up: 2FA is now on.
    const off = await req('/api/profile/totp/disable', json({ password: adminPassword, code: recovery_codes[0] }, cookie));
    assert.strictEqual(off.status, 200);
  });

  it('refuses a second setup while 2FA is enabled', async () => {
    const cookie = await loginAs('admin', adminPassword);
    const { recovery } = await enableTotpFor(cookie, 'admin');
    const setup = await req('/api/profile/totp/setup', json({}, cookie));
    assert.strictEqual(setup.status, 409);
    await req('/api/profile/totp/disable', json({ password: adminPassword, code: recovery[0] }, cookie));
  });

  it('rejects an unknown challenge', async () => {
    const res = await req('/api/auth/login/2fa', json({ challenge: 'made-up', code: '123456' }));
    assert.strictEqual(res.status, 400);
  });
});

// With OIDC the identity provider owns the second factor, so the profile must not offer
// TOTP. Runs last because it swaps the global settings object.
describe('Two-factor with OIDC configured', () => {
  const settingsFile = path.join(os.tmpdir(), `scenarii-profile-oidc-${process.pid}.yml`);

  after(() => {
    fs.writeFileSync(settingsFile, 'auth:\n  default_user: admin\n');
    reloadSettings();
    fs.unlinkSync(settingsFile);
  });

  it('reports TOTP as unavailable and refuses setup', async () => {
    // Settings are global and cached, so point the loader at this file for the run.
    fs.writeFileSync(settingsFile, [
      'auth:',
      '  default_user: admin',
      '  oidc:',
      '    issuer: https://id.example.com',
      '    client_id: scenarii',
      '    client_secret: secret',
      '    redirect_uri: http://localhost:3000/api/auth/callback',
      '',
    ].join('\n'));
    loadSettings(settingsFile);

    // The provider check does not need a session, so call it directly.
    assert.strictEqual(oidcManaged(), true);
    assert.strictEqual(getProfile('admin').totp_enabled, false);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}