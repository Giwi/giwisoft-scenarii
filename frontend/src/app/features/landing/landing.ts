import { Component, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
import { NgIf, NgFor } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../shared/auth';

interface Feature {
  icon: string;
  title: string;
  text: string;
}

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [NgIf, NgFor, FormsModule, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './landing.html',
  styleUrl: './landing.css',
})
export class LandingComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly authenticated = this.auth.status;
  username = '';
  password = '';
  error = '';
  busy = false;
  next = '/scenarios';

  readonly features: Feature[] = [
    { icon: 'bi-file-text', title: 'YAML-defined', text: 'Scenarios are plain YAML files. HTTP requests or browser interactions, with step-by-step expectations and variable extraction.' },
    { icon: 'bi-clock', title: 'Cron scheduling', text: 'Every 5 minutes, hourly, daily: any cron expression. Pause and resume schedules from the dashboard without touching files.' },
    { icon: 'bi-laptop', title: 'Browser and HTTP', text: 'Native fetch for API checks, Lightpanda headless browser for full page interaction: click, fill, select, evaluate, screenshot.' },
    { icon: 'bi-database', title: 'SQLite storage', text: 'Every run and step persisted in SQLite with WAL mode. Configurable retention, optional automated daily backups, no external database.' },
    { icon: 'bi-bell', title: 'Multi-channel alerts', text: 'State transitions (pass to fail, fail to pass) via Telegram, Slack, Discord, email, or a generic webhook, with retry and backoff.' },
    { icon: 'bi-activity', title: 'Live dashboard', text: 'Response time and success rate charts, SLA gauge, run history, live step ticker over WebSocket, JSON and CSV export.' },
  ];

  async ngOnInit(): Promise<void> {
    await this.auth.load();
    if (this.auth.status().authenticated) return;
    const next = new URLSearchParams(location.search).get('next');
    if (next?.startsWith('/') && !next.startsWith('//')) this.next = next;
  }

  async submit(): Promise<void> {
    this.error = '';
    this.busy = true;
    try {
      this.error = (await this.auth.login(this.username, this.password)) ?? '';
      if (!this.error) await this.router.navigateByUrl(this.next);
    } catch {
      this.error = 'Login failed';
    } finally {
      this.busy = false;
    }
  }

  oidcLogin(): void {
    this.auth.loginWithOidc();
  }
}
