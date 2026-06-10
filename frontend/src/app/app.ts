import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { NgIf } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, NgIf],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <nav class="navbar navbar-expand">
      <div class="container">
        <a class="navbar-brand fw-semibold" routerLink="/">
          <i class="bi bi-activity me-2"></i>Scenarii
        </a>
        <div class="ms-auto d-flex gap-2 align-items-center">
          <button
            *ngIf="authConfigured && !authenticated"
            class="btn btn-sm btn-primary"
            (click)="login()"
          >
            <i class="bi bi-box-arrow-in-right me-1"></i>Sign in
          </button>
          <button
            *ngIf="authenticated"
            class="btn btn-sm btn-outline-secondary border-0"
            (click)="logout()"
            title="Sign out"
          >
            <i class="bi bi-box-arrow-right"></i>
          </button>
          <button
            class="btn btn-sm btn-outline-secondary border-0 position-relative"
            (click)="copyStatusLink()"
            title="Copy public status link"
            aria-label="Copy public status link"
          >
            <i class="bi bi-share"></i>
            <span *ngIf="copied" class="position-absolute small bg-success text-white rounded px-1 py-0" style="top:-8px;right:-8px;font-size:.6rem;line-height:1.2">Copied!</span>
          </button>
          <button
            class="btn btn-sm btn-outline-secondary border-0"
            (click)="toggleTheme()"
            aria-label="Toggle theme"
          >
            <i
              class="bi"
              [class.bi-sun-fill]="theme === 'light'"
              [class.bi-moon-fill]="theme === 'dark'"
            ></i>
          </button>
        </div>
      </div>
    </nav>

    <div class="container py-3 flex-fill" *ngIf="!authConfigured || authenticated">
      <router-outlet />
    </div>

    <div class="container d-flex flex-column align-items-center justify-content-center flex-fill gap-3" *ngIf="authConfigured && !authenticated">
      <div class="text-center" style="margin-top:15vh">
        <i class="bi bi-shield-lock fs-1 mb-3 d-block" style="color: var(--accent)"></i>
        <h2 class="h4 fw-semibold">Welcome to Scenarii</h2>
        <p class="text-secondary mb-4">Sign in to access the monitoring dashboard</p>
        <button class="btn btn-primary btn-lg" (click)="login()">
          <i class="bi bi-box-arrow-in-right me-2"></i>Sign in
        </button>
      </div>
    </div>

    <footer
      class="text-center py-3 small text-secondary border-top"
      style="border-color: var(--border) !important; background: var(--header-bg); backdrop-filter: blur(12px);"
    >
      <div class="container">
        &copy;
        <a
          href="https://giwi.fr"
          target="_blank"
          rel="noopener"
          class="text-decoration-none fw-medium"
          style="color: var(--accent)"
          >GiwiSoft</a
        >
        2026
      </div>
    </footer>
  `,
})
export class App implements OnInit {
  theme = 'light';
  authenticated = false;
  authConfigured = false;
  copied = false;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    this.theme = localStorage.getItem('scenarii-theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', this.theme);
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        this.authenticated = data.authenticated;
        this.authConfigured = data.configured;
      }
    } catch {
      this.authenticated = false;
      this.authConfigured = false;
    }
    this.cdr.detectChanges();
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('scenarii-theme', this.theme);
    document.documentElement.setAttribute('data-bs-theme', this.theme);
  }

  async copyStatusLink(): Promise<void> {
    const url = window.location.origin + '/public/status';
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    this.copied = true;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => { this.copied = false; this.cdr.detectChanges(); }, 2000);
    this.cdr.detectChanges();
  }

  login(): void {
    window.location.href = '/api/auth/login';
  }

  async logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch { /* ignore */ }
    this.authenticated = false;
    window.location.reload();
  }
}
