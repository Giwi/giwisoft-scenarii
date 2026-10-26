import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { initStorage, closeStorage } from '../src/config/storage';
import {
  hashPassword, verifyPassword, generatePassword,
  createUser, setPassword, setRole, deleteUser, getUser, listUsers, countUsers,
  verifyCredentials, ensureUser, ensureDefaultUser, normalizeRole,
} from '../src/config/users';

before(async () => { await initStorage(':memory:'); });
after(async () => { await closeStorage(); });

describe('hashPassword / verifyPassword', () => {
  it('accepts the correct password', () => {
    const stored = hashPassword('s3cr3t');
    assert.strictEqual(verifyPassword('s3cr3t', stored), true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('s3cr3t');
    assert.strictEqual(verifyPassword('nope', stored), false);
  });

  it('salts each hash so identical passwords differ', () => {
    assert.notStrictEqual(hashPassword('same'), hashPassword('same'));
  });

  it('rejects malformed stored hashes', () => {
    assert.strictEqual(verifyPassword('x', ''), false);
    assert.strictEqual(verifyPassword('x', 'bcrypt$aa$bb'), false);
    assert.strictEqual(verifyPassword('x', 'scrypt$aa$bb'), false);
  });
});

describe('generatePassword', () => {
  it('produces a 24-character alphanumeric password', () => {
    const pw = generatePassword();
    assert.strictEqual(pw.length, 24);
    assert.match(pw, /^[A-Za-z0-9]+$/);
  });

  it('produces a different password each time', () => {
    assert.notStrictEqual(generatePassword(), generatePassword());
  });
});

describe('user store', () => {
  it('creates a user and verifies its credentials', async () => {
    assert.strictEqual(await createUser('alice', 'alice-pw'), true);
    assert.strictEqual(await verifyCredentials('alice', 'alice-pw'), 'alice');
  });

  it('refuses to create a duplicate user', async () => {
    await createUser('bob', 'bob-pw');
    assert.strictEqual(await createUser('bob', 'other'), false);
    assert.strictEqual(await verifyCredentials('bob', 'bob-pw'), 'bob');
  });

  it('rejects an unknown user and a wrong password alike', async () => {
    assert.strictEqual(await verifyCredentials('ghost', 'whatever'), undefined);
    assert.strictEqual(await verifyCredentials('alice', 'wrong'), undefined);
    assert.strictEqual(await verifyCredentials('', ''), undefined);
  });

  it('changes a password, invalidating the old one', async () => {
    assert.strictEqual(await setPassword('alice', 'new-pw'), true);
    assert.strictEqual(await verifyCredentials('alice', 'new-pw'), 'alice');
    assert.strictEqual(await verifyCredentials('alice', 'alice-pw'), undefined);
  });

  it('reports false when changing a password for an unknown user', async () => {
    assert.strictEqual(await setPassword('ghost', 'x'), false);
  });

  it('lists users with metadata', async () => {
    const users = await listUsers();
    assert.ok(users.some(u => u.username === 'alice'));
    assert.ok(users.every(u => typeof u.created_at === 'string'));
    assert.ok((await countUsers()) >= 2);
    assert.strictEqual((await getUser('alice'))?.username, 'alice');
    assert.strictEqual(await getUser('ghost'), undefined);
  });
});

describe('roles', () => {
  it('defaults new users to the user role', async () => {
    await createUser('carol', 'carol-pw');
    assert.strictEqual((await getUser('carol'))?.role, 'user');
  });

  it('creates admins explicitly', async () => {
    assert.strictEqual(await createUser('root', 'root-pw', 'admin'), true);
    assert.strictEqual((await getUser('root'))?.role, 'admin');
  });

  it('promotes and demotes a user', async () => {
    assert.strictEqual(await setRole('carol', 'admin'), true);
    assert.strictEqual((await getUser('carol'))?.role, 'admin');
    assert.strictEqual(await setRole('carol', 'user'), true);
    assert.strictEqual((await getUser('carol'))?.role, 'user');
  });

  it('reports false when changing the role of an unknown user', async () => {
    assert.strictEqual(await setRole('ghost', 'admin'), false);
  });

  it('deletes a user', async () => {
    assert.strictEqual(await deleteUser('carol'), true);
    assert.strictEqual(await getUser('carol'), undefined);
    assert.strictEqual(await deleteUser('carol'), false);
  });

  it('normalizes unknown roles to the least privileged one', () => {
    assert.strictEqual(normalizeRole('admin'), 'admin');
    assert.strictEqual(normalizeRole('user'), 'user');
    assert.strictEqual(normalizeRole('root'), 'user');
    assert.strictEqual(normalizeRole(undefined), 'user');
  });
});

describe('ensureUser (OIDC JIT provisioning)', () => {
  it('creates the user on first call and reuses it afterwards', async () => {
    assert.strictEqual(await ensureUser('oidc-user'), 'oidc-user');
    assert.strictEqual((await getUser('oidc-user'))?.username, 'oidc-user');
    assert.strictEqual(await ensureUser('oidc-user'), 'oidc-user');
    assert.strictEqual((await listUsers()).filter(u => u.username === 'oidc-user').length, 1);
  });

  it('applies the role derived from the provider groups', async () => {
    await ensureUser('oidc-admin', 'admin');
    assert.strictEqual((await getUser('oidc-admin'))?.role, 'admin');
  });

  it('syncs the role on every login so a group change applies', async () => {
    await ensureUser('oidc-user', 'admin');
    assert.strictEqual((await getUser('oidc-user'))?.role, 'admin');
    await ensureUser('oidc-user', 'user');
    assert.strictEqual((await getUser('oidc-user'))?.role, 'user');
  });
});

describe('ensureDefaultUser', () => {
  it('creates the default user as admin, once', async () => {
    assert.strictEqual(await ensureDefaultUser(), true);
    assert.strictEqual((await getUser('admin'))?.role, 'admin');
    // Second call is a no-op: no new password is generated.
    assert.strictEqual(await ensureDefaultUser(), false);
  });
});
