import { describe, it } from 'node:test';
import assert from 'node:assert';
import { usernameFromClaims, groupsFromClaims, roleFromGroups } from '../src/routes/auth';

describe('usernameFromClaims', () => {
  it('uses the configured claim first', () => {
    const claims = { login: 'bob', preferred_username: 'bob.mu', email: 'bob@example.com', sub: 'abc' };
    assert.strictEqual(usernameFromClaims(claims, 'login'), 'bob');
    assert.strictEqual(usernameFromClaims(claims), 'bob.mu');
  });

  it('falls back to email then sub', () => {
    assert.strictEqual(usernameFromClaims({ email: 'bob@example.com', sub: 'abc' }), 'bob@example.com');
    assert.strictEqual(usernameFromClaims({ sub: 'abc' }), 'abc');
  });

  it('throws when no claim yields a username', () => {
    assert.throws(() => usernameFromClaims({}));
    assert.throws(() => usernameFromClaims({ sub: '' }));
    assert.throws(() => usernameFromClaims({ sub: 42 }));
  });
});

describe('groupsFromClaims', () => {
  it('reads arrays', () => {
    assert.deepStrictEqual(groupsFromClaims({ groups: ['a', 'b', 3] }), ['a', 'b']);
  });

  it('splits strings on spaces and commas', () => {
    assert.deepStrictEqual(groupsFromClaims({ groups: 'a b,c' }), ['a', 'b', 'c']);
  });

  it('honours the configured claim and falls back to groups then roles', () => {
    const claims = { teams: ['x'], groups: ['g'], roles: ['r'] };
    assert.deepStrictEqual(groupsFromClaims(claims, 'teams'), ['x']);
    assert.deepStrictEqual(groupsFromClaims(claims), ['g']);
    assert.deepStrictEqual(groupsFromClaims({ roles: ['r'] }), ['r']);
    assert.deepStrictEqual(groupsFromClaims({}), []);
  });
});

describe('roleFromGroups', () => {
  const config = { groups_claim: 'groups', admin_group: 'scenarii-admins' };

  it('grants admin to members of the admin group', () => {
    assert.strictEqual(roleFromGroups({ groups: ['scenarii-admins'] }, config), 'admin');
    assert.strictEqual(roleFromGroups({ groups: 'dev scenarii-admins' }, config), 'admin');
  });

  it('gives everyone else the plain user role', () => {
    assert.strictEqual(roleFromGroups({ groups: ['dev'] }, config), 'user');
    assert.strictEqual(roleFromGroups({}, config), 'user');
  });

  it('never grants admin when no admin group is configured', () => {
    assert.strictEqual(roleFromGroups({ groups: ['scenarii-admins'] }, { groups_claim: 'groups' }), 'user');
    assert.strictEqual(roleFromGroups({ groups: ['scenarii-admins'] }), 'user');
  });
});