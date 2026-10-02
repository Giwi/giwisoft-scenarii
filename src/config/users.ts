import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from './storage';
import { getSettings } from './settings';
import logger from '../utils/logger';
import { DEFAULT_LANG, Lang, normalizeLang } from '../i18n';

export const DEFAULT_USERNAME = 'admin';
const KEYLEN = 64;

// Role of a user: admins may manage users, plain users may only browse scenarios.
export type UserRole = 'admin' | 'user';

export const DEFAULT_ROLE: UserRole = 'user';

// Colour scheme chosen in the user profile.
export type ColorScheme = 'light' | 'dark' | 'auto';

// Coerces anything into a valid role, defaulting to the least privileged one.
export function normalizeRole(role: unknown): UserRole {
  return role === 'admin' ? 'admin' : DEFAULT_ROLE;
}

// Coerces anything into a supported colour scheme.
export function normalizeColorScheme(scheme: unknown): ColorScheme {
  return scheme === 'dark' || scheme === 'auto' ? scheme : 'light';
}

export interface UserRecord {
  username: string;
  role: UserRole;
  created_at: string;
}

// Profile fields a user owns and can change themselves.
export interface UserProfile {
  email: string | null;
  has_avatar: boolean; // false means "fall back to Gravatar"
  lang: Lang;
  color_scheme: ColorScheme;
  totp_enabled: boolean;
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
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrate(handle);
  return handle;
}

// Brings older tables up to date: adds the role column and promotes the earliest
// account to admin so existing installs do not lose control, then adds the profile
// columns introduced with the profile page.
function migrate(handle: Database.Database): void {
  const columns = (handle.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
  if (!columns.includes('role')) {
    handle.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    const oldest = handle.prepare('SELECT username FROM users ORDER BY created_at LIMIT 1').get() as
      { username: string } | undefined;
    if (oldest) handle.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(oldest.username);
  }
  const additions: [string, string][] = [
    ['email', 'TEXT'],
    // The avatar is a cropped, already-scaled image, small enough to live in the
    // database. That avoids a directory to create, back up and mount.
    ['avatar', 'BLOB'],
    ['avatar_mime', 'TEXT'],
    ['lang', `TEXT NOT NULL DEFAULT '${DEFAULT_LANG}'`],
    ['color_scheme', "TEXT NOT NULL DEFAULT 'light'"],
    ['totp_secret', 'TEXT'],
    ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['totp_recovery', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.includes(name)) handle.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
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

// Returns the stored password hash, or undefined when the user does not exist. Callers
// verify it themselves so a wrong password still costs a scrypt round.
export function getPasswordHash(username: string): string | undefined {
  const row = db().prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as
    { password_hash: string } | undefined;
  return row?.password_hash;
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

// ── Profile ─────────────────────────────────────────────────────────────────

interface ProfileRow {
  email: string | null;
  avatar: Buffer | null;
  lang: string;
  color_scheme: string;
  totp_enabled: number;
}

function toProfile(row: ProfileRow | undefined): UserProfile {
  return {
    email: row?.email || null,
    has_avatar: !!row?.avatar,
    lang: normalizeLang(row?.lang),
    color_scheme: normalizeColorScheme(row?.color_scheme),
    totp_enabled: !!row?.totp_enabled,
  };
}

// Returns the profile fields of a user, with safe defaults for missing rows.
export function getProfile(username: string): UserProfile {
  const row = db()
    .prepare('SELECT email, avatar, lang, color_scheme, totp_enabled FROM users WHERE username = ?')
    .get(username) as ProfileRow | undefined;
  return toProfile(row);
}

// Updates the profile fields a user owns. Undefined values are left untouched.
export function setProfile(username: string, patch: Partial<UserProfile>): UserProfile {
  const current = getProfile(username);
  const next = {
    email: patch.email === undefined ? current.email : patch.email,
    lang: patch.lang === undefined ? current.lang : normalizeLang(patch.lang),
    color_scheme: patch.color_scheme === undefined ? current.color_scheme : normalizeColorScheme(patch.color_scheme),
  };
  db().prepare('UPDATE users SET email = ?, lang = ?, color_scheme = ? WHERE username = ?')
    .run(next.email, next.lang, next.color_scheme, username);
  return { ...next, has_avatar: current.has_avatar, totp_enabled: current.totp_enabled };
}

// ── Avatar ──────────────────────────────────────────────────────────────────

// Returns the stored avatar image, or undefined when the user has none (Gravatar then).
export function getAvatar(username: string): { mime: string; bytes: Buffer } | undefined {
  const row = db().prepare('SELECT avatar, avatar_mime FROM users WHERE username = ?').get(username) as
    { avatar: Buffer | null; avatar_mime: string | null } | undefined;
  if (!row?.avatar?.length) return undefined;
  return { mime: row.avatar_mime || 'image/png', bytes: Buffer.from(row.avatar) };
}

// Stores the avatar image, replacing any previous one.
export function setAvatar(username: string, mime: string, bytes: Buffer): void {
  db().prepare('UPDATE users SET avatar = ?, avatar_mime = ? WHERE username = ?').run(bytes, mime, username);
}

// Drops the avatar so the user falls back to Gravatar.
export function deleteAvatar(username: string): void {
  db().prepare('UPDATE users SET avatar = NULL, avatar_mime = NULL WHERE username = ?').run(username);
}

// Sets the 2FA shared secret without enabling it yet (the pending setup state).
export function setTotpSecret(username: string, secret: string | null, recovery?: string[]): void {
  if (secret === null) {
    db().prepare('UPDATE users SET totp_secret = NULL, totp_recovery = NULL WHERE username = ?').run(username);
    return;
  }
  db().prepare('UPDATE users SET totp_secret = ?, totp_recovery = ? WHERE username = ?')
    .run(secret, recovery ? JSON.stringify(recovery) : null, username);
}

// Enables 2FA for a user, storing the recovery codes as JSON.
export function enableTotp(username: string, secret: string, recovery: string[]): boolean {
  const res = db().prepare('UPDATE users SET totp_secret = ?, totp_recovery = ?, totp_enabled = 1 WHERE username = ?')
    .run(secret, JSON.stringify(recovery), username);
  return res.changes > 0;
}

// Disables 2FA and drops the secret and recovery codes.
export function disableTotp(username: string): boolean {
  const res = db().prepare('UPDATE users SET totp_secret = NULL, totp_recovery = NULL, totp_enabled = 0 WHERE username = ?')
    .run(username);
  return res.changes > 0;
}

// Returns the stored 2FA secret, or undefined when the user has none.
export function getTotpSecret(username: string): string | undefined {
  const row = db().prepare('SELECT totp_secret FROM users WHERE username = ?').get(username) as
    { totp_secret: string | null } | undefined;
  return row?.totp_secret || undefined;
}

// Returns the unused recovery codes of a user.
export function getRecoveryCodes(username: string): string[] {
  const row = db().prepare('SELECT totp_recovery FROM users WHERE username = ?').get(username) as
    { totp_recovery: string | null } | undefined;
  if (!row?.totp_recovery) return [];
  try {
    return JSON.parse(row.totp_recovery) as string[];
  } catch {
    return [];
  }
}

// Consumes one recovery code, returning true when it was valid.
export function useRecoveryCode(username: string, code: string): boolean {
  const remaining = getRecoveryCodes(username);
  const index = remaining.findIndex(c => c === code);
  if (index === -1) return false;
  remaining.splice(index, 1);
  db().prepare('UPDATE users SET totp_recovery = ? WHERE username = ?').run(JSON.stringify(remaining), username);
  return true;
}

// ── Password recovery ───────────────────────────────────────────────────────

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Creates a single-use recovery token for a user and returns the clear value.
// Only the hash is stored, so a database copy cannot be replayed.
export function createPasswordReset(username: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const handle = db();
  handle.prepare('DELETE FROM password_resets WHERE username = ?').run(username);
  handle.prepare('INSERT INTO password_resets (token_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), username, new Date(Date.now() + RESET_TTL_MS).toISOString(), new Date().toISOString());
  return token;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Consumes a recovery token and applies the new password. Returns false when the
// token is unknown or expired.
export function resetPasswordWithToken(token: string, password: string): boolean {
  const handle = db();
  const row = handle.prepare('SELECT username, expires_at FROM password_resets WHERE token_hash = ?')
    .get(hashToken(token)) as { username: string; expires_at: string } | undefined;
  if (!row) return false;
  handle.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(hashToken(token));
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  setPassword(row.username, password);
  logger.info({ user: row.username }, 'Password reset from recovery token');
  return true;
}

// Drops expired recovery tokens. Cheap enough to run on every request creation.
export function prunePasswordResets(): void {
  db().prepare('DELETE FROM password_resets WHERE expires_at < ?').run(new Date().toISOString());
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