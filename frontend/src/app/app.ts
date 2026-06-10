import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { isAuthenticated, getAuthToken, setAuthToken, clearAuthToken } from './api';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, NgIf, FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <nav class="navbar navbar-expand">
      <div class="container">
        <a class="navbar-brand fw-semibold" routerLink="/">
          <i class="bi bi-activity me-2"></i>Scenarii
        </a>
        <div class="ms-auto d-flex gap-2 align-items-center">
          <div *ngIf="!authenticated && loginError" class="small text-danger me-1">{{ loginError }}</div>
          <div *ngIf="!authenticated" class="d-flex gap-1">
            <input
              type="password"
              class="form-control form-control-sm"
              style="width:140px"
              placeholder="Password"
              [(ngModel)]="password"
              (keydown.enter)="login()"
            />
            <button class="btn btn-sm btn-primary" (click)="login()" [disabled]="!password">Sign in</button>
          </div>
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
  password = '';
  loginError = '';

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.theme = localStorage.getItem('scenarii-theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', this.theme);
    this.authenticated = isAuthenticated();
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('scenarii-theme', this.theme);
    document.documentElement.setAttribute('data-bs-theme', this.theme);
  }

  async login(): Promise<void> {
    this.loginError = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.password }),
      });
      if (res.ok) {
        const data = await res.json();
        setAuthToken(data.token);
        this.authenticated = true;
        this.password = '';
      } else {
        this.loginError = 'Invalid password';
      }
    } catch {
      this.loginError = 'Connection error';
    }
    this.cdr.detectChanges();
  }

  logout(): void {
    clearAuthToken();
    this.authenticated = false;
    window.location.reload();
  }
}
