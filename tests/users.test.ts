import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { initStorage, closeStorage } from '../src/config/storage';
import {
  hashPassword, verifyPassword, generatePassword,
  createUser, setPassword, setRole, deleteUser, getUser, listUsers, countUsers,
  verifyCredentials, ensureUser, ensureDefaultUser, normalizeRole,
} from '../src/config/users';

before(() => { initStorage(':memory:'); });
after(() => { closeStorage(); });

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
  it('creates a user and verifies its credentials', () => {
    assert.strictEqual(createUser('alice', 'alice-pw'), true);
    assert.strictEqual(verifyCredentials('alice', 'alice-pw'), 'alice');
  });

  it('refuses to create a duplicate user', () => {
    createUser('bob', 'bob-pw');
    assert.strictEqual(createUser('bob', 'other'), false);
    assert.strictEqual(verifyCredentials('bob', 'bob-pw'), 'bob');
  });

  it('rejects an unknown user and a wrong password alike', () => {
    assert.strictEqual(verifyCredentials('ghost', 'whatever'), undefined);
    assert.strictEqual(verifyCredentials('alice', 'wrong'), undefined);
    assert.strictEqual(verifyCredentials('', ''), undefined);
  });

  it('changes a password, invalidating the old one', () => {
    assert.strictEqual(setPassword('alice', 'new-pw'), true);
    assert.strictEqual(verifyCredentials('alice', 'new-pw'), 'alice');
    assert.strictEqual(verifyCredentials('alice', 'alice-pw'), undefined);
  });

  it('reports false when changing a password for an unknown user', () => {
    assert.strictEqual(setPassword('ghost', 'x'), false);
  });

  it('lists users with metadata', () => {
    const users = listUsers();
    assert.ok(users.some(u => u.username === 'alice'));
    assert.ok(users.every(u => typeof u.created_at === 'string'));
    assert.ok(countUsers() >= 2);
    assert.strictEqual(getUser('alice')?.username, 'alice');
    assert.strictEqual(getUser('ghost'), undefined);
  });
});

describe('roles', () => {
  it('defaults new users to the user role', () => {
    createUser('carol', 'carol-pw');
    assert.strictEqual(getUser('carol')?.role, 'user');
  });

  it('creates admins explicitly', () => {
    assert.strictEqual(createUser('root', 'root-pw', 'admin'), true);
    assert.strictEqual(getUser('root')?.role, 'admin');
  });

  it('promotes and demotes a user', () => {
    assert.strictEqual(setRole('carol', 'admin'), true);
    assert.strictEqual(getUser('carol')?.role, 'admin');
    assert.strictEqual(setRole('carol', 'user'), true);
    assert.strictEqual(getUser('carol')?.role, 'user');
  });

  it('reports false when changing the role of an unknown user', () => {
    assert.strictEqual(setRole('ghost', 'admin'), false);
  });

  it('deletes a user', () => {
    assert.strictEqual(deleteUser('carol'), true);
    assert.strictEqual(getUser('carol'), undefined);
    assert.strictEqual(deleteUser('carol'), false);
  });

  it('normalizes unknown roles to the least privileged one', () => {
    assert.strictEqual(normalizeRole('admin'), 'admin');
    assert.strictEqual(normalizeRole('user'), 'user');
    assert.strictEqual(normalizeRole('root'), 'user');
    assert.strictEqual(normalizeRole(undefined), 'user');
  });
});

describe('ensureUser (OIDC JIT provisioning)', () => {
  it('creates the user on first call and reuses it afterwards', () => {
    assert.strictEqual(ensureUser('oidc-user'), 'oidc-user');
    assert.strictEqual(getUser('oidc-user')?.username, 'oidc-user');
    assert.strictEqual(ensureUser('oidc-user'), 'oidc-user');
    assert.strictEqual(listUsers().filter(u => u.username === 'oidc-user').length, 1);
  });

  it('applies the role derived from the provider groups', () => {
    ensureUser('oidc-admin', 'admin');
    assert.strictEqual(getUser('oidc-admin')?.role, 'admin');
  });

  it('syncs the role on every login so a group change applies', () => {
    ensureUser('oidc-user', 'admin');
    assert.strictEqual(getUser('oidc-user')?.role, 'admin');
    ensureUser('oidc-user', 'user');
    assert.strictEqual(getUser('oidc-user')?.role, 'user');
  });
});

describe('ensureDefaultUser', () => {
  it('creates the default user as admin, once', () => {
    assert.strictEqual(ensureDefaultUser(), true);
    assert.strictEqual(getUser('admin')?.role, 'admin');
    // Second call is a no-op: no new password is generated.
    assert.strictEqual(ensureDefaultUser(), false);
  });
});
