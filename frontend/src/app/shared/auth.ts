import { Injectable, computed, signal } from '@angular/core';

export type AuthProvider = 'local' | 'oidc' | null;

export type UserRole = 'admin' | 'user' | null;

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
  role: UserRole;
  provider: AuthProvider;
  // Language and colour scheme chosen in the profile, mirrored into the interface.
  lang: string;
  color_scheme: string;
  avatar_url: string | null;
}

// Outcome of a call that answers with a message: an error, or a confirmation.
export interface ApiResult {
  error?: string;
  message?: string;
}

// Outcome of a login attempt: an error message, or the second factor to answer next.
export interface LoginResult extends ApiResult {
  challenge?: string;
}

// Session state shared by the app shell, the route guard, and the login form.
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly status = signal<AuthStatus>({
    authenticated: false, username: null, role: null, provider: null,
    lang: 'en', color_scheme: 'light', avatar_url: null,
  });
  readonly ready = signal(false);

  // True when the session user may manage other users.
  readonly isAdmin = computed(() => this.status().role === 'admin');

  private inflight: Promise<void> | null = null;

  // Fetches the session status once, deduplicating concurrent callers.
  load(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const res = await fetch('/api/auth/me', { credentials: 'include' });
          if (res.ok) {
            this.status.set(await res.json() as AuthStatus);
          }
        } catch {
          // Network failure: leave the status unauthenticated, the guard will send us to /login.
        } finally {
          this.ready.set(true);
        }
      })();
    }
    return this.inflight;
  }

  // First step: username and password. When the account has two-factor authentication the
  // server answers with a challenge instead of a session, so no cookie is set yet.
  async login(username: string, password: string): Promise<LoginResult> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return { error: await this.errorOf(res) };
    const body = await res.json() as { requires_2fa?: boolean; challenge?: string };
    if (body.requires_2fa) return { challenge: body.challenge };
    await this.reload();
    return {};
  }

  // Second step: exchanges a challenge for a session once the code checks out.
  async loginWithTotp(challenge: string, code: string): Promise<LoginResult> {
    const res = await fetch('/api/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ challenge, code }),
    });
    if (!res.ok) return { error: await this.errorOf(res) };
    await this.reload();
    return {};
  }

  // Requests a password recovery link. The reply is the same whether the account exists
  // or not, so it never reveals anything.
  async requestPasswordReset(identifier: string): Promise<ApiResult> {
    const res = await fetch('/api/auth/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ identifier }),
    });
    if (!res.ok) return { error: await this.errorOf(res) };
    const body = await res.json() as { message?: string };
    return { message: body.message };
  }

  // Applies a recovery token and sets the new password.
  async resetPassword(token: string, password: string): Promise<ApiResult> {
    const res = await fetch('/api/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token, password }),
    });
    if (!res.ok) return { error: await this.errorOf(res) };
    const body = await res.json() as { message?: string };
    return { message: body.message };
  }

  // Server errors come back already translated, so they are shown verbatim.
  private async errorOf(res: Response): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || `HTTP ${res.status}`;
  }

  loginWithOidc(): void {
    window.location.href = '/api/auth/oidc';
  }

  async logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch { /* ignore: the cookie is cleared server-side regardless */ }
    await this.reload();
  }

  // Re-reads the status, bypassing the one-shot cache. Public so the profile page can
  // refresh the navbar avatar after an upload or an email change.
  async reload(): Promise<void> {
    this.inflight = null;
    await this.load();
  }
}
