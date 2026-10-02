import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { getSettings, AuthProvider } from '../config/settings';
import {
  verifyCredentials, ensureUser, getUser, listUsers, createUser, setPassword, setRole,
  deleteUser, generatePassword, normalizeRole, UserRole, getProfile, getPasswordHash,
  getTotpSecret, useRecoveryCode, verifyPassword,
} from '../config/users';
import { verifyTotp } from '../utils/totp';
import { avatarUrlFor } from '../config/avatar';
import { DEFAULT_LANG, Lang, langFromAcceptLanguage, normalizeLang, t } from '../i18n';
import logger from '../utils/logger';

interface Session {
  username: string;
  role: UserRole;
  provider: AuthProvider;
  createdAt: number;
}

// In-memory session store for authenticated users
const sessions = new Map<string, Session>();

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Returns the active auth provider: OIDC when configured, local password login otherwise.
// Auth is on by default: an explicit `enabled: false` is the only way to turn it off.
export function authProvider(): AuthProvider | null {
  const config = getSettings().auth;
  if (config?.enabled === false) return null;
  return config?.oidc ? 'oidc' : 'local';
}

// Generates a cryptographically random session identifier.
function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Parses a raw Cookie header into a key-value map.
function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) cookies[key] = val;
    }
  }
  return cookies;
}

const SESSION_COOKIE = 'scenarii-session';

// API paths that never require a session.
const PUBLIC_API_PATHS = ['/api/auth/', '/api/public/', '/api/health', '/api/status', '/api/metrics'];

// Returns the session attached to the request cookie, or undefined when absent/expired.
function getSession(req: express.Request): Session | undefined {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sessionId);
    return undefined;
  }
  return session;
}

// The username of the request's session, or undefined when unauthenticated.
export function sessionUsername(req: express.Request): string | undefined {
  return getSession(req)?.username;
}

// The language a response should use: the signed-in user's profile choice, and for
// anonymous visitors (login page, public status page) the Accept-Language header.
export function requestLang(req: express.Request): Lang {
  const session = getSession(req);
  if (session) return getProfile(session.username).lang;
  return langFromAcceptLanguage(req.headers['accept-language']);
}

// Sets the session cookie and returns its value.
function startSession(res: express.Response, username: string, provider: AuthProvider): void {
  const sessionId = generateSessionId();
  sessions.set(sessionId, { username, role: getUser(username)?.role ?? 'user', provider, createdAt: Date.now() });
  const secure = res.req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
}

// True when the raw request carries a valid session. Used by the WebSocket upgrade check.
export function isAuthenticatedRequest(req: { headers: { cookie?: string } }): boolean {
  if (!authProvider()) return true;
  const header = req.headers.cookie;
  if (typeof header !== 'string') return false;
  const sessionId = parseCookies(header)[SESSION_COOKIE];
  if (!sessionId || !sessions.has(sessionId)) return false;
  return Date.now() - sessions.get(sessionId)!.createdAt <= SESSION_TTL;
}

// Express middleware guarding the API: any /api/* path outside PUBLIC_API_PATHS needs a session.
export function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authProvider()) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API_PATHS.some(p => req.path === p || req.path.startsWith(p))) return next();
  if (!getSession(req)) {
    res.status(401).json({ error: t('auth.required', requestLang(req)) });
    return;
  }
  next();
}

// Guards admin-only API routes: requires a session whose user has the admin role.
// When auth is disabled every request passes through.
export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authProvider()) return next();
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: t('auth.required', requestLang(req)) });
    return;
  }
  // Re-read the role so a promotion or demotion takes effect on the next request.
  const role = getUser(session.username)?.role ?? 'user';
  if (role !== 'admin') {
    res.status(403).json({ error: t('auth.admin_required', requestLang(req)) });
    return;
  }
  next();
}

// Guards non-API page requests: unauthenticated visitors are redirected to the landing/login page.
// Public status pages stay reachable without a session.
export function pageAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authProvider()) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) return next();
  // The landing/login page is where visitors are sent, so it stays reachable.
  if (req.path === '/login') return next();
  // Static assets (bundles, fonts, favicon) must load for the landing page to render.
  if (req.path.startsWith('/assets/') || path.extname(req.path)) return next();
  if (getSession(req)) return next();
  res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// Local username/password login. Sets a session cookie on success. When the account has
// two-factor authentication enabled the response asks for a code instead of logging in,
// and the session is only created once that code checks out.
export function handleLocalLogin(req: express.Request, res: express.Response): void {
  const lang = requestLang(req);
  if (authProvider() !== 'local') {
    res.status(400).json({ error: t('auth.password_login_disabled', lang) });
    return;
  }
  const { username, password } = req.body as { username?: string; password?: string };
  const user = verifyCredentials(username ?? '', password ?? '');
  if (!user) {
    logger.warn({ username }, 'Failed login attempt');
    res.status(401).json({ error: t('auth.invalid_credentials', lang) });
    return;
  }
  if (getProfile(user).totp_enabled) {
    const challenge = createChallenge(user);
    res.json({ requires_2fa: true, challenge, message: t('auth.totp_required', lang) });
    return;
  }
  finishLogin(res, user);
}

// Second step of the login: exchanges a challenge for a session once the code (or a
// recovery code) is verified. Challenges are single use and expire quickly.
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

interface LoginChallenge {
  username: string;
  attempts: number;
  expiresAt: number;
}

const challenges = new Map<string, LoginChallenge>();

// Passwords only, no 2FA: shared by the first login step and the challenge exchange.
function finishLogin(res: express.Response, username: string, lang: Lang = DEFAULT_LANG): void {
  startSession(res, username, 'local');
  logger.info({ username, role: getUser(username)?.role }, 'User logged in');
  res.json({ username, role: getUser(username)?.role, provider: 'local', lang });
}

// Issues a short-lived challenge id for a user that passed the password step.
function createChallenge(username: string): string {
  pruneChallenges();
  const id = crypto.randomBytes(24).toString('hex');
  challenges.set(id, { username, attempts: 0, expiresAt: Date.now() + CHALLENGE_TTL });
  return id;
}

// Completes a two-factor login. A wrong code is retried a few times, then the challenge
// is dropped so the password has to be entered again.
const MAX_CHALLENGE_ATTEMPTS = 3;

export function handleTwoFactorLogin(req: express.Request, res: express.Response): void {
  const lang = requestLang(req);
  const { challenge, code } = req.body as { challenge?: string; code?: string };
  const pending = challenge ? challenges.get(challenge) : undefined;
  if (!pending || pending.expiresAt < Date.now()) {
    if (challenge) challenges.delete(challenge);
    res.status(400).json({ error: t('auth.totp_required', lang) });
    return;
  }
  if (pending.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    challenges.delete(challenge!);
    res.status(429).json({ error: t('auth.rate_limited', lang) });
    return;
  }
  pending.attempts++;
  const secret = getTotpSecret(pending.username);
  const supplied = String(code ?? '').trim();
  if (!secret || !(verifyTotp(secret, supplied) || useRecoveryCode(pending.username, supplied))) {
    logger.warn({ username: pending.username }, 'Failed two-factor attempt');
    res.status(401).json({ error: t('auth.totp_invalid', lang) });
    return;
  }
  challenges.delete(challenge!);
  finishLogin(res, pending.username, lang);
}

// Drops login challenges whose window has passed. Called whenever a new one is issued.
export function pruneChallenges(): void {
  const now = Date.now();
  for (const [id, pending] of challenges) if (pending.expiresAt < now) challenges.delete(id);
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

// Fetches the OIDC discovery document to get authorization, token, and userinfo endpoints.
async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const data = await res.json() as OidcDiscovery;
  return data;
}

// In-memory OIDC state store (validated during callback, cleaned every 10 minutes)
const oidcStates = new Map<string, { createdAt: number }>();
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

// Removes OIDC state entries that are older than the TTL.
function cleanOidcStates(): void {
  const now = Date.now();
  for (const [key, val] of oidcStates) {
    if (now - val.createdAt > STATE_TTL) oidcStates.delete(key);
  }
}

// Redirects the user to the OIDC provider's authorization page.
export async function handleOidcLogin(req: express.Request, res: express.Response): Promise<void> {
  const oidc = getSettings().auth?.oidc;
  if (authProvider() !== 'oidc' || !oidc) {
    res.status(400).json({ error: t('auth.oidc_not_configured', requestLang(req)) });
    return;
  }
  cleanOidcStates();

  const state = crypto.randomBytes(16).toString('hex');
  oidcStates.set(state, { createdAt: Date.now() });

  try {
    const discovery = await fetchOidcDiscovery(oidc.issuer_url);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oidc.client_id,
      redirect_uri: oidc.redirect_uri,
      scope: oidc.scopes || 'openid profile email',
      state,
    });
    res.redirect(`${discovery.authorization_endpoint}?${params}`);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'OIDC login redirect failed');
    res.status(502).json({ error: t('auth.oidc_unreachable', requestLang(req)) });
  }
}

// Extracts a stable username from OIDC userinfo claims. The claim is configurable
// (auth.oidc.username_claim); email and sub are used as fallbacks.
export function usernameFromClaims(claims: Record<string, unknown>, claim?: string): string {
  const keys = [claim, 'preferred_username', 'email', 'sub'].filter((k): k is string => !!k);
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === 'string' && value) return value;
  }
  throw new Error('OIDC claims contain no usable username');
}

// Extracts group memberships from the configured claim, accepting a string, an array,
// or a space/comma separated list.
export function groupsFromClaims(claims: Record<string, unknown>, claim?: string): string[] {
  const keys = [claim, 'groups', 'roles'].filter((k): k is string => !!k);
  for (const key of keys) {
    const value = claims[key];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

// Derives the local role from the OIDC groups: membership of auth.oidc.admin_group
// grants admin, everyone else gets a plain user.
export function roleFromGroups(
  claims: Record<string, unknown>,
  config?: { groups_claim?: string; admin_group?: string }
): UserRole {
  if (!config?.admin_group) return 'user';
  const groups = groupsFromClaims(claims, config.groups_claim);
  return groups.includes(config.admin_group) ? 'admin' : 'user';
}

// Fetches the authenticated user's claims from the provider's userinfo endpoint.
async function fetchUserInfo(discovery: OidcDiscovery, accessToken: string): Promise<Record<string, unknown>> {
  if (!discovery.userinfo_endpoint) throw new Error('OIDC provider has no userinfo_endpoint');
  const res = await fetch(discovery.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo request failed: ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

// Handles the OIDC callback, exchanges the code for tokens, and sets a session cookie.
// Unknown identities are provisioned on the fly (JIT) in the local user DB.
export async function handleOidcCallback(req: express.Request, res: express.Response): Promise<void> {
  const oidc = getSettings().auth?.oidc;
  if (authProvider() !== 'oidc' || !oidc) {
    res.status(400).json({ error: t('auth.oidc_not_configured', requestLang(req)) });
    return;
  }
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.status(400).json({ error: t('auth.oidc_missing_code', requestLang(req)) });
    return;
  }

  cleanOidcStates();
  if (!oidcStates.has(state)) {
    res.status(400).json({ error: t('auth.oidc_invalid_state', requestLang(req)) });
    return;
  }
  oidcStates.delete(state);

  try {
    const discovery = await fetchOidcDiscovery(oidc.issuer_url);
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oidc.redirect_uri,
        client_id: oidc.client_id,
        client_secret: oidc.client_secret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error({ status: tokenRes.status, body: errText }, 'OIDC token exchange failed');
      res.status(500).json({ error: t('auth.oidc_token_failed', requestLang(req)) });
      return;
    }

    const tokens = await tokenRes.json() as { access_token?: string };
    if (!tokens.access_token) throw new Error('Token response has no access_token');
    const claims = await fetchUserInfo(discovery, tokens.access_token);
    const username = ensureUser(usernameFromClaims(claims, oidc.username_claim), roleFromGroups(claims, oidc));

    startSession(res, username, 'oidc');
    logger.info({ username, role: getUser(username)?.role }, 'User logged in via OIDC');
    res.redirect('/scenarios');
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'OIDC callback failed');
    res.status(500).json({ error: t('auth.oidc_failed', requestLang(req)) });
  }
}

// Returns the current authentication status to the client. The language comes from the
// Accept-Language header so the login page can pick one before there is a session.
export function handleAuthMe(req: express.Request, res: express.Response): void {
  const provider = authProvider();
  if (!provider) {
    res.json({ authenticated: true, username: null, role: null, provider: null, lang: requestLang(req) });
    return;
  }
  const session = getSession(req);
  const profile = session ? getProfile(session.username) : undefined;
  res.json({
    authenticated: !!session,
    username: session?.username ?? null,
    role: session ? getUser(session.username)?.role ?? 'user' : null,
    provider,
    lang: profile?.lang ?? requestLang(req),
    color_scheme: profile?.color_scheme ?? 'light',
    avatar_url: session ? avatarUrlFor(session.username) : null,
  });
}

// ── User management (admin only) ────────────────────────────────────────────

// Lists the local users.
export function handleListUsers(_req: express.Request, res: express.Response): void {
  res.json({ users: listUsers() });
}

// Creates a user. Without OIDC, only an admin may do this. The password is generated
// and returned once when the caller does not supply one.
export function handleCreateUser(req: express.Request, res: express.Response): void {
  const { username, password, role } = req.body as { username?: string; password?: string; role?: string };
  if (!username?.trim()) {
    res.status(400).json({ error: t('auth.username_required', requestLang(req)) });
    return;
  }
  if (getUser(username.trim())) {
    res.status(409).json({ error: t('auth.user_exists', requestLang(req)) });
    return;
  }
  const generated = !password;
  const secret = password || generatePassword();
  const created = createUser(username.trim(), secret, normalizeRole(role));
  if (!created) {
    res.status(409).json({ error: t('auth.user_exists', requestLang(req)) });
    return;
  }
  logger.info({ username, role: normalizeRole(role) }, 'User created');
  res.status(201).json({ ...getUser(username.trim()), generated_password: generated ? secret : undefined });
}

// Changes a user's password. When no password is supplied, one is generated and returned once.
export function handleSetUserPassword(req: express.Request, res: express.Response): void {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username) {
    res.status(400).json({ error: t('auth.username_required', requestLang(req)) });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: t('auth.unknown_user', requestLang(req)) });
    return;
  }
  const secret = password || generatePassword();
  setPassword(username, secret);
  logger.info({ username }, 'Password updated');
  res.json({ status: 'updated', generated_password: password ? undefined : secret });
}

// Changes a user's role. Admins cannot change their own role: that is the surest way to
// lock the install out of user management.
export function handleSetUserRole(req: express.Request, res: express.Response): void {
  const { username, role } = req.body as { username?: string; role?: string };
  if (!username || !role) {
    res.status(400).json({ error: t('auth.role_required', requestLang(req)) });
    return;
  }
  if (username === getSession(req)?.username) {
    res.status(400).json({ error: t('auth.own_role', requestLang(req)) });
    return;
  }
  const next = normalizeRole(role);
  if (!setRole(username, next)) {
    res.status(404).json({ error: t('auth.unknown_user', requestLang(req)) });
    return;
  }
  logger.info({ username, role: next }, 'Role updated');
  res.json({ status: 'updated', role: next });
}

// Deletes a user. Your own account is protected: that also makes the last admin
// undeletable through the API, since the caller is always an admin too.
export function handleDeleteUser(req: express.Request, res: express.Response): void {
  const username = String(req.params.username);
  if (username === getSession(req)?.username) {
    res.status(400).json({ error: t('auth.own_delete', requestLang(req)) });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: t('auth.unknown_user', requestLang(req)) });
    return;
  }
  deleteUser(username);
  logger.info({ username }, 'User deleted');
  res.json({ status: 'deleted' });
}

// Logs out by deleting the session and clearing the cookie.
export function handleLogout(req: express.Request, res: express.Response): void {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  res.json({ status: 'logged_out' });
}
