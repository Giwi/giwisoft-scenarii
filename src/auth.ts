import express from 'express';
import crypto from 'crypto';
import { getSettings } from './settings';
import logger from './logger';

// In-memory session store for OIDC-authenticated users
const sessions = new Map<string, { createdAt: number }>();

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

// Express middleware that checks for a valid session cookie on /api/* routes (except public/auth/health endpoints).
export function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const config = getSettings().auth;
  if (!config?.enabled) return next();
  if (!req.path.startsWith('/api/')) return next();
  const publicPrefixes = ['/api/auth/', '/api/public/'];
  if (publicPrefixes.some(p => req.path.startsWith(p)) || req.path === '/api/health' || req.path === '/api/status') return next();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

// Fetches OIDC discovery document to get authorization and token endpoints.
async function fetchOidcDiscovery(issuerUrl: string): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const data = await res.json() as { authorization_endpoint: string; token_endpoint: string };
  return {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
  };
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
export function handleOidcLogin(req: express.Request, res: express.Response): void {
  const config = getSettings().auth;
  if (!config?.enabled || !config.oidc) {
    res.status(400).json({ error: 'OIDC not configured' });
    return;
  }
  const oidc = config.oidc;
  cleanOidcStates();

  const state = crypto.randomBytes(16).toString('hex');
  oidcStates.set(state, { createdAt: Date.now() });

  const scopes = encodeURIComponent(oidc.scopes || 'openid profile email');
  const authUrl = `${oidc.issuer_url.replace(/\/$/, '')}/authorize?response_type=code&client_id=${encodeURIComponent(oidc.client_id)}&redirect_uri=${encodeURIComponent(oidc.redirect_uri)}&scope=${scopes}&state=${state}`;

  res.redirect(authUrl);
}

// Handles the OIDC callback, exchanges the code for tokens, and sets a session cookie.
export async function handleOidcCallback(req: express.Request, res: express.Response): Promise<void> {
  const config = getSettings().auth;
  if (!config?.enabled || !config.oidc) {
    res.status(400).json({ error: 'OIDC not configured' });
    return;
  }
  const oidc = config.oidc;
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

    const sessionId = generateSessionId();
    sessions.set(sessionId, { createdAt: Date.now() });

    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    res.redirect('/');
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'OIDC callback failed');
    res.status(500).json({ error: 'OIDC authentication failed' });
  }
}

// Returns the current authentication status to the client.
export function handleAuthMe(req: express.Request, res: express.Response): void {
  const config = getSettings().auth;
  const configured = !!(config?.enabled && config?.oidc);
  if (!configured) {
    res.json({ authenticated: false, configured: false });
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  res.json({
    authenticated: !!sessionId && sessions.has(sessionId),
    configured: true,
  });
}

// Logs out by deleting the session and clearing the cookie.
export function handleLogout(req: express.Request, res: express.Response): void {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ status: 'logged_out' });
}
