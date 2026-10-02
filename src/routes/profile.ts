import express from 'express';
import QRCode from 'qrcode';
import {
  getProfile, setProfile, UserProfile, getUser, setPassword, getPasswordHash, setTotpSecret,
  getTotpSecret, enableTotp, disableTotp, useRecoveryCode, getAvatar, setAvatar, deleteAvatar,
  createPasswordReset, resetPasswordWithToken, prunePasswordResets, verifyPassword, ColorScheme,
} from '../config/users';
import { getDb } from '../config/storage';
import { avatarUrlFor, decodeDataUrl, gravatarUrl, isOversizedDataUrl, isValidEmail } from '../config/avatar';
import { requestLang, sessionUsername } from './auth';
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from '../utils/totp';
import { sendMailgunEmail } from '../notifications/email-client';
import { getSettings } from '../config/settings';
import { normalizeLang, t } from '../i18n';
import logger from '../utils/logger';

// ──────────────────────────────────────────
// Profile, avatar, password and two-factor routes
// ──────────────────────────────────────────
// Every handler works off the session user, never off a username in the body.

const MIN_PASSWORD_LENGTH = 8;

// Auth being off means every request is already authorised, so the profile belongs to
// the single default account.
function authDisabled(): boolean {
  return getSettings().auth?.enabled === false;
}

// The session user, or the default user when auth is disabled and nobody is logged in.
function targetUsername(req: express.Request): string | undefined {
  return sessionUsername(req) ?? (authDisabled() ? getSettings().auth?.default_user || 'admin' : undefined);
}

// Sends the session user, or a translated 401 when there is none.
function requireUser(req: express.Request, res: express.Response): string | undefined {
  const username = targetUsername(req);
  if (!username) {
    res.status(401).json({ error: t('auth.required', requestLang(req)) });
    return undefined;
  }
  return username;
}

// ── Profile ─────────────────────────────────────────────────────────────────

// Returns the profile of the session user, including the avatar URL to render.
export function handleGetProfile(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  const profile = getProfile(username);
  res.json({
    username,
    role: getUser(username)?.role ?? 'user',
    ...profile,
    avatar_url: avatarUrlFor(username, 96),
    gravatar_url: gravatarUrl(profile.email, 96),
    // TOTP belongs to the local password provider only: with OIDC the identity provider
    // owns the second factor, so the profile must not offer it.
    totp_available: !oidcManaged(),
  });
}

// Updates the profile fields the user owns: email, colour scheme, language.
export function handleUpdateProfile(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  const body = req.body as { email?: string; color_scheme?: string; lang?: string };
  const lang = requestLang(req);
  const patch: Partial<UserProfile> = {};

  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (email && !isValidEmail(email)) {
      res.status(400).json({ error: t('auth.invalid_email', lang) });
      return;
    }
    patch.email = email || null;
  }
  if (body.color_scheme !== undefined) patch.color_scheme = String(body.color_scheme) as ColorScheme;
  if (body.lang !== undefined) patch.lang = normalizeLang(body.lang);

  const profile = setProfile(username, patch);
  logger.info({ username }, 'Profile updated');
  res.json({
    status: 'updated',
    ...profile,
    avatar_url: avatarUrlFor(username, 96),
    // Translated here so the profile page can show the confirmation in its own language.
    message: t(patch.lang !== undefined ? 'profile.lang_updated'
      : patch.color_scheme !== undefined ? 'profile.theme_updated' : 'profile.updated', lang),
  });
}

// ── Avatar ──────────────────────────────────────────────────────────────────

// Stores an uploaded avatar. The browser crops and scales it to a square first.
export function handleUploadAvatar(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  const image = (req.body as { image?: string }).image;
  const decoded = decodeDataUrl(image);
  if (!decoded) {
    const lang = requestLang(req);
    const key = isOversizedDataUrl(image) ? 'profile.avatar_too_large' : 'profile.avatar_invalid';
    res.status(400).json({ error: t(key, lang) });
    return;
  }
  setAvatar(username, decoded.mime, decoded.bytes);
  logger.info({ username, mime: decoded.mime, bytes: decoded.bytes.length }, 'Avatar uploaded');
  res.json({ status: 'updated', avatar_url: avatarUrlFor(username, 96), message: t('profile.avatar_updated', requestLang(req)) });
}

// Drops the uploaded avatar so the user falls back to Gravatar.
export function handleDeleteAvatar(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  deleteAvatar(username);
  logger.info({ username }, 'Avatar removed');
  res.json({ status: 'deleted', avatar_url: avatarUrlFor(username, 96), message: t('profile.avatar_removed', requestLang(req)) });
}

// Serves a stored avatar. Public so the navbar can render it before the profile page is
// loaded; avatars are not sensitive and Gravatar is a third-party fetch anyway.
export function handleGetAvatar(req: express.Request, res: express.Response): void {
  const avatar = getAvatar(String(req.params.username));
  if (!avatar) {
    res.status(404).end();
    return;
  }
  res.type(avatar.mime).set('Cache-Control', 'private, max-age=300').send(avatar.bytes);
}

// ── Password ────────────────────────────────────────────────────────────────

// Changes the session user's password. Requires the current one, so a stolen session
// cookie alone cannot lock the owner out.
export function handleChangePassword(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  const { current_password, new_password } = req.body as { current_password?: string; new_password?: string };
  const lang = requestLang(req);
  if (!new_password || new_password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: t('auth.password_too_short', lang) });
    return;
  }
  if (!verifyPassword(String(current_password ?? ''), getPasswordHash(username) ?? '')) {
    res.status(400).json({ error: t('auth.current_password_wrong', lang) });
    return;
  }
  setPassword(username, new_password);
  logger.info({ username }, 'Password changed by the user');
  res.json({ status: 'updated', message: t('auth.password_changed', lang) });
}

// Requests a recovery link for a username or email address. The response is identical
// whether or not the account exists, so it cannot be used to enumerate users.
export function handleForgotPassword(req: express.Request, res: express.Response): void {
  prunePasswordResets();
  const lang = requestLang(req);
  const needle = String((req.body as { identifier?: string }).identifier ?? '').trim();
  if (!needle) {
    res.status(400).json({ error: t('auth.required', lang) });
    return;
  }
  if (countRecentResets(req) > MAX_RESETS_PER_HOUR) {
    res.status(429).json({ error: t('auth.rate_limited', lang) });
    return;
  }
  const username = findUserByIdentifier(needle);
  if (username) void deliverResetLink(username, createPasswordReset(username));
  else logger.info({}, 'Password recovery requested for an unknown identifier');
  res.json({ status: 'sent', message: t('auth.reset_requested', lang) });
}

// Applies a recovery token. Single use: it is consumed on the first attempt, valid or not.
export function handleResetPassword(req: express.Request, res: express.Response): void {
  prunePasswordResets();
  const lang = requestLang(req);
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token || !password) {
    res.status(400).json({ error: t('auth.reset_invalid_token', lang) });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: t('auth.password_too_short', lang) });
    return;
  }
  if (!resetPasswordWithToken(String(token), password)) {
    res.status(400).json({ error: t('auth.reset_invalid_token', lang) });
    return;
  }
  res.json({ status: 'updated', message: t('auth.reset_done', lang) });
}

// ── Two-factor (TOTP) ───────────────────────────────────────────────────────

// Starts setup: a fresh secret, its otpauth:// URI and a QR code as a data URL. Nothing
// is enabled yet, so a user who never confirms keeps password-only login.
export async function handleTotpSetup(req: express.Request, res: express.Response): Promise<void> {
  const username = requireUser(req, res);
  if (!username) return;
  const lang = requestLang(req);
  if (oidcManaged()) {
    res.status(400).json({ error: t('auth.totp_disabled_with_oidc', lang) });
    return;
  }
  if (getProfile(username).totp_enabled) {
    res.status(409).json({ error: t('auth.totp_already_enabled', lang) });
    return;
  }
  const secret = generateTotpSecret();
  const uri = totpUri(secret, username);
  setTotpSecret(username, secret);
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 240 });
  res.json({
    status: 'pending',
    secret,
    otpauth_uri: uri,
    // An SVG data URL, so it renders in an <img> without adding script to the page.
    qr_code: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    issuer: 'Scenarii',
    account: username,
  });
}

// Confirms setup: verifies a code from the authenticator app, then enables 2FA and
// returns single-use recovery codes shown exactly once.
export function handleTotpEnable(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  const lang = requestLang(req);
  if (oidcManaged()) {
    res.status(400).json({ error: t('auth.totp_disabled_with_oidc', lang) });
    return;
  }
  const secret = getTotpSecret(username);
  if (!secret) {
    res.status(400).json({ error: t('auth.totp_required', lang) });
    return;
  }
  if (!verifyTotp(secret, String((req.body as { code?: string }).code ?? ''))) {
    // Keep the pending secret: a typo in the code must not force the whole setup to
    // restart. It is only ever usable by this session's own account anyway.
    res.status(400).json({ error: t('auth.totp_invalid', lang) });
    return;
  }
  const recovery = generateRecoveryCodes();
  enableTotp(username, secret, recovery);
  logger.info({ username }, 'Two-factor authentication enabled');
  res.json({ status: 'enabled', recovery_codes: recovery, message: t('auth.totp_enabled', lang) });
}

// Turns 2FA off. Requires the password and a current code (or a recovery code), so
// neither a hijacked session nor a borrowed phone can silently disable it.
export function handleTotpDisable(req: express.Request, res: express.Response): void {
  const username = requireUser(req, res);
  if (!username) return;
  const lang = requestLang(req);
  const { password, code } = req.body as { password?: string; code?: string };
  if (!verifyPassword(String(password ?? ''), getPasswordHash(username) ?? '')) {
    res.status(400).json({ error: t('auth.current_password_wrong', lang) });
    return;
  }
  const secret = getTotpSecret(username);
  const supplied = String(code ?? '').trim();
  if (!secret || !(verifyTotp(secret, supplied) || useRecoveryCode(username, supplied))) {
    res.status(400).json({ error: t('auth.totp_invalid', lang) });
    return;
  }
  disableTotp(username);
  logger.info({ username }, 'Two-factor authentication disabled');
  res.json({ status: 'disabled', message: t('auth.totp_disabled', lang) });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// With OIDC configured the identity provider owns the second factor, so local TOTP is not
// offered: the profile hides it and these endpoints refuse it.
export function oidcManaged(): boolean {
  return !authDisabled() && !!getSettings().auth?.oidc;
}

// Finds a username from either a username or an email address.
export function findUserByIdentifier(needle: string): string | undefined {
  const wanted = needle.toLowerCase();
  const row = getDb()
    .prepare('SELECT username FROM users WHERE lower(username) = ? OR lower(email) = ?')
    .get(wanted, wanted) as { username: string } | undefined;
  return row?.username;
}

// Emails the recovery link when an email channel is configured, logs it otherwise.
async function deliverResetLink(username: string, token: string): Promise<void> {
  const link = `/login?reset=${encodeURIComponent(token)}`;
  const email = getSettings().notifications?.email;
  const profile = getProfile(username);
  if (email?.enabled && email.mailgun?.api_key && profile.email) {
    try {
      await sendMailgunEmail(
        email.mailgun.api_key,
        email.mailgun.domain,
        email.mailgun.from,
        [profile.email],
        'Scenarii password recovery',
        `Hello ${username},\n\nReset your Scenarii password with this link (valid for one hour):\n${link}\n\n`
        + 'If you did not ask for it, ignore this message.',
      );
      logger.info({ username }, 'Password recovery link emailed');
      return;
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to email recovery link');
    }
  }
  logger.warn({ username, link }, 'Password recovery link (no email channel configured, read it from the logs)');
}

// Per-IP throttle for recovery requests: 5 per hour.
const MAX_RESETS_PER_HOUR = 5;
const resetAttempts = new Map<string, number[]>();

function countRecentResets(req: express.Request): number {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (resetAttempts.get(ip) || []).filter(ts => now - ts < 3600_000);
  recent.push(now);
  resetAttempts.set(ip, recent);
  return recent.length;
}