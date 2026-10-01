import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from './storage';
import { getSettings } from './settings';
import logger from '../utils/logger';

export const DEFAULT_USERNAME = 'admin';
const KEYLEN = 64;

// Role of a user: admins may manage users, plain users may only browse scenarios.
export type UserRole = 'admin' | 'user';

export const DEFAULT_ROLE: UserRole = 'user';

// Coerces anything into a valid role, defaulting to the least privileged one.
export function normalizeRole(role: unknown): UserRole {
  return role === 'admin' ? 'admin' : DEFAULT_ROLE;
}

export interface UserRecord {
  username: string;
  role: UserRole;
  created_at: string;
}

// ── Password hashing ────────────────────────────────────────────────────────

// Hashes a password with a random salt. Format: scrypt$<saltHex>$<hashHex>
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Verifies a password against a stored hash in constant time.
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== KEYLEN) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password, salt, KEYLEN), expected);
}

// Generates a readable random password (24 chars, no ambiguous characters).
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ── Persistence ─────────────────────────────────────────────────────────────

function db(): Database.Database {
  const handle = getDb();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    );
  `);
  migrate(handle);
  return handle;
}

// Brings an older users table up to date: adds the role column and promotes the
// earliest account to admin so existing installs do not lose control.
function migrate(handle: Database.Database): void {
  const columns = (handle.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
  if (!columns.includes('role')) {
    handle.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    const oldest = handle.prepare('SELECT username FROM users ORDER BY created_at LIMIT 1').get() as
      { username: string } | undefined;
    if (oldest) handle.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(oldest.username);
  }
}

// Returns the user row, or undefined if unknown.
export function getUser(username: string): UserRecord | undefined {
  const row = db().prepare('SELECT username, role, created_at FROM users WHERE username = ?').get(username) as
    (UserRecord & { role: string }) | undefined;
  return row ? { ...row, role: normalizeRole(row.role) } : undefined;
}

// Returns all users ordered by username.
export function listUsers(): UserRecord[] {
  const rows = db().prepare('SELECT username, role, created_at FROM users ORDER BY username').all() as
    (UserRecord & { role: string })[];
  return rows.map(r => ({ ...r, role: normalizeRole(r.role) }));
}

// Returns the number of stored users.
export function countUsers(): number {
  return (db().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
}

// Creates a user. Returns false when the username is already taken.
export function createUser(username: string, password: string, role: UserRole = DEFAULT_ROLE): boolean {
  const res = db().prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, hashPassword(password), normalizeRole(role), new Date().toISOString());
  return res.changes > 0;
}

// Overwrites a user's password. Returns false when the user does not exist.
export function setPassword(username: string, password: string): boolean {
  const res = db().prepare('UPDATE users SET password_hash = ? WHERE username = ?')
    .run(hashPassword(password), username);
  return res.changes > 0;
}

// Changes a user's role. Returns false when the user does not exist.
export function setRole(username: string, role: UserRole): boolean {
  const res = db().prepare('UPDATE users SET role = ? WHERE username = ?').run(normalizeRole(role), username);
  return res.changes > 0;
}

// Deletes a user. Returns false when the user does not exist.
export function deleteUser(username: string): boolean {
  return db().prepare('DELETE FROM users WHERE username = ?').run(username).changes > 0;
}

// Creates the user row if missing (OIDC JIT provisioning) and syncs its role from
// the provider groups. Returns the username.
export function ensureUser(username: string, role: UserRole = DEFAULT_ROLE): string {
  if (getUser(username)) setRole(username, role);
  else createUser(username, generatePassword(), role);
  return username;
}

// Checks a username/password pair. Returns the username on success, undefined otherwise.
export function verifyCredentials(username: string, password: string): string | undefined {
  if (!username || !password) return undefined;
  const row = db().prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as
    { password_hash: string } | undefined;
  if (!row) {
    // Hash anyway so a missing user costs the same as a wrong password.
    verifyPassword(password, `scrypt$${'0'.repeat(32)}$${'0'.repeat(KEYLEN * 2)}`);
    return undefined;
  }
  return verifyPassword(password, row.password_hash) ? username : undefined;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

// Ensures the configured default user exists, generating and logging a password on creation.
// The default user is always an admin so a fresh install can be managed. Returns true when
// a user was created (i.e. a fresh password was printed).
export function ensureDefaultUser(): boolean {
  const username = getSettings().auth?.default_user || DEFAULT_USERNAME;
  const role = normalizeRole(getSettings().auth?.default_user_role ?? 'admin');
  const existing = getUser(username);
  if (existing) {
    if (existing.role !== role) setRole(username, role);
    return false;
  }
  const password = generatePassword();
  createUser(username, password, role);
  logger.warn(
    { user: username, password },
    `Created default user "${username}" with generated password (change it with: scenarii user passwd ${username})`
  );
  return true;
}
