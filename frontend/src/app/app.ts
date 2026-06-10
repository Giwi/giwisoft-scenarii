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
          <button *ngIf="!authenticated" class="btn btn-sm btn-primary" (click)="login()">
            <i class="bi bi-box-arrow-in-right me-1"></i>Sign in
          </button>
          <button *ngIf="authenticated" class="btn btn-sm btn-outline-secondary border-0" (click)="logout()" title="Sign out">
            <i class="bi bi-box-arrow-right"></i>
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
    <div class="container py-3 flex-fill">
      <router-outlet />
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

  constructor(private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    this.theme = localStorage.getItem('scenarii-theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', this.theme);
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        this.authenticated = data.authenticated;
      }
    } catch {
      this.authenticated = false;
    }
    this.cdr.detectChanges();
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('scenarii-theme', this.theme);
    document.documentElement.setAttribute('data-bs-theme', this.theme);
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
