// Scoped API token helpers. Tokens are configured under api.auth.tokens and are
// independent from dashboard sessions: CI can use a narrow read/trigger token while
// humans keep using cookies. The legacy api.auth.api_key acts as an admin token.

import express from 'express';
import crypto from 'crypto';
import { getSettings, ApiScope } from './settings';
import logger from '../utils/logger';

const ALL_SCOPES: ApiScope[] = ['read', 'trigger', 'admin'];

// True when the API token layer is enabled. When false, callers fall back to sessions
// (or to no auth at all when the main auth provider is also disabled).
export function apiAuthEnabled(): boolean {
  return getSettings().api?.auth?.enabled === true;
}

// Constant-time comparison to avoid leaking token prefixes through timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Expands configured scopes: `admin` implies every other scope.
export function expandScopes(scopes: ApiScope[] | undefined): Set<ApiScope> {
  const set = new Set<ApiScope>();
  for (const scope of scopes ?? []) {
    if (!ALL_SCOPES.includes(scope)) continue;
    set.add(scope);
    if (scope === 'admin') {
      set.add('read');
      set.add('trigger');
    }
  }
  return set;
}

// Extracts the bearer token from the Authorization header, if present.
export function bearerToken(req: express.Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token || undefined;
}

// Resolves scopes for the request's bearer token. Returns null when no bearer token is
// present, the token layer is disabled, or the token does not match a configured entry.
export function tokenScopesFromRequest(req: express.Request): Set<ApiScope> | null {
  const token = bearerToken(req);
  if (!token) return null;
  if (!apiAuthEnabled()) return null;

  const auth = getSettings().api?.auth;
  if (!auth) return null;

  if (auth.api_key && safeEqual(token, auth.api_key)) {
    return expandScopes(['admin']);
  }

  for (const entry of auth.tokens ?? []) {
    if (!entry?.token) continue;
    if (safeEqual(token, entry.token)) {
      return expandScopes(entry.scopes ?? ['admin']);
    }
  }

  logger.warn({ tokenPrefix: token.slice(0, 6) }, 'Rejected unknown API token');
  return null;
}

// True when the resolved scopes satisfy the required scope.
export function scopesSatisfy(scopes: Set<ApiScope>, required: ApiScope): boolean {
  return scopes.has(required);
}
