import { Component, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav class="navbar navbar-expand">
      <div class="container">
        <a class="navbar-brand fw-semibold" routerLink="/">
          <i class="bi bi-activity me-2"></i>Scenarii
        </a>
        <div class="ms-auto">
            <button class="btn btn-sm btn-outline-secondary border-0" (click)="toggleTheme()" aria-label="Toggle theme">
            <i class="bi" [class.bi-sun-fill]="theme === 'light'" [class.bi-moon-fill]="theme === 'dark'"></i>
          </button>
        </div>
      </div>
    </nav>
    <div class="container py-3 min-vh-100">
      <router-outlet />
    </div>
    <footer class="text-center py-3 small text-secondary border-top" style="border-color: var(--border) !important; background: var(--header-bg); backdrop-filter: blur(12px);">
      <div class="container">
        &copy; <a href="https://giwi.fr" target="_blank" rel="noopener" class="text-decoration-none fw-medium" style="color: var(--accent)">GiwiSoft</a> 2026
      </div>
    </footer>
  `,
})
export class App implements OnInit {
  theme = 'light';

  ngOnInit() {
    this.theme = localStorage.getItem('scenarii-theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', this.theme);
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('scenarii-theme', this.theme);
    document.documentElement.setAttribute('data-bs-theme', this.theme);
  }
}
