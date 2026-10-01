import { Injectable, computed, signal } from '@angular/core';

export type AuthProvider = 'local' | 'oidc' | null;

export type UserRole = 'admin' | 'user' | null;

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
  role: UserRole;
  provider: AuthProvider;
}

// Session state shared by the app shell, the route guard, and the login form.
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly status = signal<AuthStatus>({ authenticated: false, username: null, role: null, provider: null });
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

  async login(username: string, password: string): Promise<string | null> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Login failed' })) as { error?: string };
      return data.error || 'Login failed';
    }
    await this.reload();
    return null;
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

  // Re-reads the status, bypassing the one-shot cache.
  private async reload(): Promise<void> {
    this.inflight = null;
    await this.load();
  }
}
