import { Component, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
import { Router, RouterOutlet, RouterLink } from '@angular/router';
import { NgIf } from '@angular/common';
import { AuthService } from './shared/auth';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, NgIf],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private auth = inject(AuthService);

  theme = 'light';
  status = this.auth.status;
  isAdmin = this.auth.isAdmin;
  ready = this.auth.ready;
  router = inject(Router);

  async ngOnInit() {
    this.theme = localStorage.getItem('scenarii-theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', this.theme);
    await this.auth.load();
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('scenarii-theme', this.theme);
    document.documentElement.setAttribute('data-bs-theme', this.theme);
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    window.location.href = '/login';
  }
}
