import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { getSettings, AuthProvider } from '../config/settings';
import {
  verifyCredentials, ensureUser, getUser, listUsers, createUser, setPassword, setRole,
  deleteUser, generatePassword, normalizeRole, UserRole,
} from '../config/users';
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
    res.status(401).json({ error: 'Authentication required' });
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
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  // Re-read the role so a promotion or demotion takes effect on the next request.
  const role = getUser(session.username)?.role ?? 'user';
  if (role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
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

// Local username/password login. Sets a session cookie on success.
export function handleLocalLogin(req: express.Request, res: express.Response): void {
  if (authProvider() !== 'local') {
    res.status(400).json({ error: 'Password login is disabled' });
    return;
  }
  const { username, password } = req.body as { username?: string; password?: string };
  const user = verifyCredentials(username ?? '', password ?? '');
  if (!user) {
    logger.warn({ username }, 'Failed login attempt');
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  startSession(res, user, 'local');
  logger.info({ username: user, role: getUser(user)?.role }, 'User logged in');
  res.json({ username: user, role: getUser(user)?.role, provider: 'local' });
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
export async function handleOidcLogin(_req: express.Request, res: express.Response): Promise<void> {
  const oidc = getSettings().auth?.oidc;
  if (authProvider() !== 'oidc' || !oidc) {
    res.status(400).json({ error: 'OIDC not configured' });
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
    res.status(502).json({ error: 'OIDC provider unreachable' });
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
    res.status(400).json({ error: 'OIDC not configured' });
    return;
  }
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state parameter' });
    return;
  }

  cleanOidcStates();
  if (!oidcStates.has(state)) {
    res.status(400).json({ error: 'Invalid or expired state parameter' });
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
      res.status(500).json({ error: 'Token exchange failed' });
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
    res.status(500).json({ error: 'OIDC authentication failed' });
  }
}

// Returns the current authentication status to the client.
export function handleAuthMe(req: express.Request, res: express.Response): void {
  const provider = authProvider();
  if (!provider) {
    res.json({ authenticated: true, username: null, role: null, provider: null });
    return;
  }
  const session = getSession(req);
  res.json({
    authenticated: !!session,
    username: session?.username ?? null,
    role: session ? getUser(session.username)?.role ?? 'user' : null,
    provider,
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
    res.status(400).json({ error: 'username is required' });
    return;
  }
  if (getUser(username.trim())) {
    res.status(409).json({ error: 'User already exists' });
    return;
  }
  const generated = !password;
  const secret = password || generatePassword();
  const created = createUser(username.trim(), secret, normalizeRole(role));
  if (!created) {
    res.status(409).json({ error: 'User already exists' });
    return;
  }
  logger.info({ username, role: normalizeRole(role) }, 'User created');
  res.status(201).json({ ...getUser(username.trim()), generated_password: generated ? secret : undefined });
}

// Changes a user's password. When no password is supplied, one is generated and returned once.
export function handleSetUserPassword(req: express.Request, res: express.Response): void {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username) {
    res.status(400).json({ error: 'username is required' });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: 'Unknown user' });
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
    res.status(400).json({ error: 'username and role are required' });
    return;
  }
  if (username === getSession(req)?.username) {
    res.status(400).json({ error: 'Cannot change your own role' });
    return;
  }
  const next = normalizeRole(role);
  if (!setRole(username, next)) {
    res.status(404).json({ error: 'Unknown user' });
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
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: 'Unknown user' });
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
