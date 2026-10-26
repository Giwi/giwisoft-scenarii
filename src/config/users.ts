import crypto from 'crypto';
import { getBackend } from './storage';
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

// Returns the user row, or undefined if unknown.
export async function getUser(username: string): Promise<UserRecord | undefined> {
  const row = await getBackend().getUser(username);
  return row ? { ...row, role: normalizeRole(row.role) } : undefined;
}

// Returns all users ordered by username.
export async function listUsers(): Promise<UserRecord[]> {
  const rows = await getBackend().listUsers();
  return rows.map(r => ({ ...r, role: normalizeRole(r.role) }));
}

// Returns the number of stored users.
export function countUsers(): Promise<number> {
  return getBackend().countUsers();
}

// Creates a user. Returns false when the username is already taken.
export async function createUser(username: string, password: string, role: UserRole = DEFAULT_ROLE): Promise<boolean> {
  return getBackend().insertUser(username, hashPassword(password), normalizeRole(role), new Date().toISOString());
}

// Overwrites a user's password. Returns false when the user does not exist.
export async function setPassword(username: string, password: string): Promise<boolean> {
  return getBackend().setUserPassword(username, hashPassword(password));
}

// Returns the stored password hash, or undefined when the user does not exist. Callers
// verify it themselves so a wrong password still costs a scrypt round.
export function getPasswordHash(username: string): Promise<string | undefined> {
  return getBackend().getPasswordHash(username);
}

// Changes a user's role. Returns false when the user does not exist.
export async function setRole(username: string, role: UserRole): Promise<boolean> {
  return getBackend().setUserRole(username, normalizeRole(role));
}

// Deletes a user. Returns false when the user does not exist.
export function deleteUser(username: string): Promise<boolean> {
  return getBackend().deleteUser(username);
}

// Creates the user row if missing (OIDC JIT provisioning) and syncs its role from
// the provider groups. Returns the username.
export async function ensureUser(username: string, role: UserRole = DEFAULT_ROLE): Promise<string> {
  if (await getUser(username)) await setRole(username, role);
  else await createUser(username, generatePassword(), role);
  return username;
}

// Checks a username/password pair. Returns the username on success, undefined otherwise.
export async function verifyCredentials(username: string, password: string): Promise<string | undefined> {
  if (!username || !password) return undefined;
  const row = await getBackend().getPasswordHash(username);
  if (!row) {
    // Hash anyway so a missing user costs the same as a wrong password.
    verifyPassword(password, `scrypt$${'0'.repeat(32)}$${'0'.repeat(KEYLEN * 2)}`);
    return undefined;
  }
  return verifyPassword(password, row) ? username : undefined;
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
export async function getProfile(username: string): Promise<UserProfile> {
  const row = await getBackend().getProfile(username);
  return toProfile(row as ProfileRow | undefined);
}

// Updates the profile fields a user owns. Undefined values are left untouched.
export async function setProfile(username: string, patch: Partial<UserProfile>): Promise<UserProfile> {
  const current = await getProfile(username);
  const next = {
    email: patch.email === undefined ? current.email : patch.email,
    lang: patch.lang === undefined ? current.lang : normalizeLang(patch.lang),
    color_scheme: patch.color_scheme === undefined ? current.color_scheme : normalizeColorScheme(patch.color_scheme),
  };
  await getBackend().updateProfile(username, next.email, next.lang, next.color_scheme);
  return { ...next, has_avatar: current.has_avatar, totp_enabled: current.totp_enabled };
}

// ── Avatar ──────────────────────────────────────────────────────────────────

// Returns the stored avatar image, or undefined when the user has none (Gravatar then).
export function getAvatar(username: string): Promise<{ mime: string; bytes: Buffer } | undefined> {
  return getBackend().getAvatar(username);
}

// Stores the avatar image, replacing any previous one.
export function setAvatar(username: string, mime: string, bytes: Buffer): Promise<void> {
  return getBackend().setAvatar(username, mime, bytes);
}

// Drops the avatar so the user falls back to Gravatar.
export function deleteAvatar(username: string): Promise<void> {
  return getBackend().deleteAvatar(username);
}

// ── Two-factor (TOTP) ───────────────────────────────────────────────────────

// Sets the 2FA shared secret without enabling it yet (the pending setup state).
export async function setTotpSecret(username: string, secret: string | null, recovery?: string[]): Promise<void> {
  if (secret === null) {
    await getBackend().setTotpSecret(username, null, null);
    return;
  }
  await getBackend().setTotpSecret(username, secret, recovery ? JSON.stringify(recovery) : null);
}

// Enables 2FA for a user, storing the recovery codes as JSON.
export function enableTotp(username: string, secret: string, recovery: string[]): Promise<boolean> {
  return getBackend().enableTotp(username, secret, JSON.stringify(recovery));
}

// Disables 2FA and drops the secret and recovery codes.
export function disableTotp(username: string): Promise<boolean> {
  return getBackend().disableTotp(username);
}

// Returns the stored 2FA secret, or undefined when the user has none.
export function getTotpSecret(username: string): Promise<string | undefined> {
  return getBackend().getTotpSecret(username);
}

// Returns the unused recovery codes of a user.
export function getRecoveryCodes(username: string): Promise<string[]> {
  return getBackend().getRecoveryCodes(username);
}

// Consumes one recovery code, returning true when it was valid.
export async function useRecoveryCode(username: string, code: string): Promise<boolean> {
  const remaining = await getRecoveryCodes(username);
  const index = remaining.findIndex(c => c === code);
  if (index === -1) return false;
  remaining.splice(index, 1);
  await getBackend().setRecoveryCodes(username, JSON.stringify(remaining));
  return true;
}

// ── Password recovery ───────────────────────────────────────────────────────

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Creates a single-use recovery token for a user and returns the clear value.
// Only the hash is stored, so a database copy cannot be replayed.
export async function createPasswordReset(username: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await getBackend().deletePasswordResets(username);
  await getBackend().insertPasswordReset(
    username,
    hashToken(token),
    new Date(Date.now() + RESET_TTL_MS).toISOString(),
    new Date().toISOString(),
  );
  return token;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Consumes a recovery token and applies the new password. Returns false when the
// token is unknown or expired.
export async function resetPasswordWithToken(token: string, password: string): Promise<boolean> {
  const row = await getBackend().getPasswordReset(hashToken(token));
  if (!row) return false;
  await getBackend().deletePasswordReset(hashToken(token));
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  await setPassword(row.username, password);
  logger.info({ user: row.username }, 'Password reset from recovery token');
  return true;
}

// Drops expired recovery tokens. Cheap enough to run on every request creation.
export function prunePasswordResets(): Promise<void> {
  return getBackend().prunePasswordResets(new Date().toISOString());
}

// Finds a username from either a username or an email address.
export function findUserByIdentifier(needle: string): Promise<string | undefined> {
  return getBackend().findUserByIdentifier(needle);
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

// Ensures the configured default user exists, generating and logging a password on creation.
// The default user is always an admin so a fresh install can be managed. Returns true when
// a user was created (i.e. a fresh password was printed).
export async function ensureDefaultUser(): Promise<boolean> {
  const username = getSettings().auth?.default_user || DEFAULT_USERNAME;
  const role = normalizeRole(getSettings().auth?.default_user_role ?? 'admin');
  const existing = await getUser(username);
  if (existing) {
    if (existing.role !== role) await setRole(username, role);
    return false;
  }
  const password = generatePassword();
  await createUser(username, password, role);
  logger.warn(
    { user: username, password },
    `Created default user "${username}" with generated password (change it with: scenarii user passwd ${username})`
  );
  return true;
}
