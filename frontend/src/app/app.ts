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
    <div class="container py-3">
      <router-outlet />
    </div>
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
