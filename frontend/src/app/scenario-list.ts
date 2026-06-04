import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { DatePipe, NgFor, NgIf } from '@angular/common';
import { RouterModule } from '@angular/router';

interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
}

@Component({
  selector: 'app-scenario-list',
  standalone: true,
  imports: [NgFor, NgIf, DatePipe, RouterModule],
  template: `
    <div class="container">
      <header>
        <h1>Scenarii</h1>
        <p class="subtitle">Web application scenario monitoring</p>
      </header>

      <div class="summary" *ngIf="scenarios.length > 0">
        <div class="stat">
          <span class="stat-value">{{ scenarios.length }}</span>
          <span class="stat-label">Scenarios</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ healthyCount }}</span>
          <span class="stat-label">Healthy</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ unhealthyCount }}</span>
          <span class="stat-label">Unhealthy</span>
        </div>
      </div>

      <div class="card" *ngIf="!loading && scenarios.length === 0">
        <p class="empty">No scenarios executed yet. Scenarios are running in the background — this page refreshes automatically.</p>
      </div>

      <div class="card" *ngIf="loading">
        <p class="empty">Loading scenarios...</p>
      </div>

      <table *ngIf="scenarios.length > 0">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Status</th>
            <th>Last run</th>
            <th>Duration</th>
            <th>Total runs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let s of scenarios">
            <td class="name">{{ s.name }}</td>
            <td>
              <span class="badge" [class.success]="s.last_success === 1" [class.fail]="s.last_success === 0" [class.unknown]="s.last_success === null">
                {{ s.last_success === 1 ? 'PASS' : s.last_success === 0 ? 'FAIL' : '—' }}
              </span>
            </td>
            <td>{{ s.last_run ? (s.last_run | date:'MMM d, HH:mm') : '—' }}</td>
            <td class="num">{{ s.last_duration_ms ? s.last_duration_ms + 'ms' : '—' }}</td>
            <td class="num">{{ s.total_runs }}</td>
            <td><a [routerLink]="['/scenario', s.name]" class="btn">Details</a></td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    .container { max-width: 1000px; margin: 0 auto; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    header { margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; color: #1a1a2e; }
    .subtitle { margin: 4px 0 0; color: #666; }
    .summary { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat { background: #f8f9fa; border-radius: 8px; padding: 16px 24px; text-align: center; flex: 1; }
    .stat-value { display: block; font-size: 28px; font-weight: 700; color: #1a1a2e; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
    .name { font-weight: 600; color: #1a1a2e; }
    .num { font-family: monospace; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge.success { background: #d4edda; color: #155724; }
    .badge.fail { background: #f8d7da; color: #721c24; }
    .badge.unknown { background: #e9ecef; color: #495057; }
    .btn { display: inline-block; padding: 6px 14px; background: #4361ee; color: #fff; border-radius: 4px; text-decoration: none; font-size: 13px; }
    .btn:hover { background: #3a56d4; }
    .card { background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
    .empty { color: #666; margin: 0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  `]
})
export class ScenarioListComponent implements OnInit, OnDestroy {
  scenarios: ScenarioInfo[] = [];
  loading = true;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;

  constructor(private cdr: ChangeDetectorRef) {}

  get healthyCount(): number {
    return this.scenarios.filter(s => s.last_success === 1).length;
  }

  get unhealthyCount(): number {
    return this.scenarios.filter(s => s.last_success === 0).length;
  }

  async ngOnInit(): Promise<void> {
    await this.fetchScenarios();
    this.pollTimer = setInterval(() => {
      if (!this.fetching) this.fetchScenarios();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async fetchScenarios(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const res = await fetch('/api/scenarios');
      if (res.ok) {
        this.scenarios = await res.json();
      }
    } catch {
      // Server not ready yet — will retry on next poll
    } finally {
      this.fetching = false;
      this.loading = false;
      this.cdr.detectChanges();
    }
  }
}
