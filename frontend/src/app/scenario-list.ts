import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { DatePipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { onScenarioRun, removeScenarioRunListener, ScenarioRunEvent } from './ws';

interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  paused?: boolean;
  scheduled?: boolean;
  tags?: string[];
}

@Component({
  selector: 'app-scenario-list',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, DatePipe, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="d-flex align-items-center gap-3 mb-4">
      <h1 class="h4 mb-0">Scenarios</h1>
      <span class="badge bg-secondary rounded-pill fs-6" *ngIf="scenarios.length">{{
        scenarios.length
      }}</span>
      <div class="ms-auto d-flex gap-2">
        <select class="form-select form-select-sm" style="width:auto" [(ngModel)]="tagFilter" (ngModelChange)="onTagFilterChange()" *ngIf="allTags.length">
          <option value="">All tags</option>
          <option *ngFor="let t of allTags" [value]="t">{{ t }}</option>
        </select>
        <button
          class="btn btn-sm btn-outline-primary"
          (click)="fetchScenarios()"
          [disabled]="fetching"
          title="Refresh"
        >
          <i class="bi bi-arrow-clockwise"></i>
        </button>
      </div>
    </div>

    <div class="row g-3 mb-4" *ngIf="scenarios.length">
      <div class="col-md-4">
        <div class="card border-0 shadow-sm text-center p-3">
          <div class="fs-3 fw-bold">{{ scenarios.length }}</div>
          <div class="small text-secondary text-uppercase">Scenarios</div>
        </div>
      </div>
      <div class="col-md-4">
        <div class="card border-0 shadow-sm text-center p-3">
          <div class="fs-3 fw-bold text-success">{{ healthyCount }}</div>
          <div class="small text-secondary text-uppercase">Healthy</div>
        </div>
      </div>
      <div class="col-md-4">
        <div class="card border-0 shadow-sm text-center p-3">
          <div class="fs-3 fw-bold text-danger">{{ unhealthyCount }}</div>
          <div class="small text-secondary text-uppercase">Unhealthy</div>
        </div>
      </div>
    </div>

    <div class="card border-0 shadow-sm py-5 text-center text-secondary" *ngIf="loading">
      <i class="bi bi-hourglass-split fs-2 mb-2 d-block"></i>
      Loading scenarios...
    </div>

    <div
      class="card border-0 shadow-sm py-5 text-center text-secondary"
      *ngIf="!loading && scenarios.length === 0"
    >
      <i class="bi bi-inbox fs-2 mb-2 d-block"></i>
      No scenarios yet. Background runs will appear here.
    </div>

    <div class="card border-0 shadow-sm" *ngIf="scenarios.length">
      <div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead class="table-light">
            <tr>
              <th>Scenario</th>
              <th>Tags</th>
              <th>Status</th>
              <th>Last run</th>
              <th>Duration</th>
              <th>Runs</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let s of scenarios">
              <td class="fw-semibold">{{ s.name }}</td>
              <td>
                <span class="badge bg-info me-1" *ngFor="let tag of (s.tags || [])" style="font-size:.7rem">{{ tag }}</span>
                <span class="text-secondary small" *ngIf="!s.tags?.length">—</span>
              </td>
              <td>
                <span
                  class="badge"
                  [class.bg-success]="s.last_success === 1"
                  [class.bg-danger]="s.last_success === 0"
                  [class.bg-secondary]="s.last_success === null"
                >
                  {{ s.last_success === 1 ? 'Pass' : s.last_success === 0 ? 'Fail' : '—' }}
                </span>
              </td>
              <td class="text-body-secondary small">
                {{ s.last_run ? (s.last_run | date: 'MMM d, HH:mm') : '—' }}
              </td>
              <td class="font-monospace small">
                {{ s.last_duration_ms ? s.last_duration_ms + 'ms' : '—' }}
              </td>
              <td class="font-monospace small">{{ s.total_runs }}</td>
              <td class="text-end">
                <button class="btn btn-sm btn-outline-success me-1" (click)="runNow(s.name)" [disabled]="running === s.name" title="Run now">
                  <i class="bi bi-play-fill me-1"></i>{{ running === s.name ? '...' : '' }}
                </button>
                <button
                  class="btn btn-sm me-1"
                  [class.btn-outline-warning]="!s.paused"
                  [class.btn-outline-success]="s.paused"
                  (click)="togglePause(s)"
                  *ngIf="s.scheduled"
                  [title]="s.paused ? 'Resume' : 'Pause'"
                >
                  <i class="bi" [class.bi-pause-fill]="!s.paused" [class.bi-play-fill]="s.paused"></i>
                </button>
                <a [routerLink]="['/scenario', s.name]" class="btn btn-sm btn-outline-primary" title="Details">
                  <i class="bi bi-graph-up"></i>
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class ScenarioListComponent implements OnInit, OnDestroy {
  scenarios: ScenarioInfo[] = [];
  loading = true;
  running = '';
  tagFilter = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  fetching = false;

  get allTags(): string[] {
    const tags = new Set<string>();
    for (const s of this.scenarios) {
      for (const t of (s.tags || [])) {
        tags.add(t);
      }
    }
    return [...tags].sort();
  }

  constructor(private cdr: ChangeDetectorRef) {}

  get healthyCount(): number {
    return this.scenarios.filter((s) => s.last_success === 1).length;
  }

  get unhealthyCount(): number {
    return this.scenarios.filter((s) => s.last_success === 0).length;
  }

  async ngOnInit(): Promise<void> {
    await this.fetchScenarios();
    this.pollTimer = setInterval(() => {
      if (!this.fetching) this.fetchScenarios();
    }, 5000);

    onScenarioRun(this.wsCallback);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    removeScenarioRunListener(this.wsCallback);
  }

  private wsCallback = () => {
    if (!this.fetching) this.fetchScenarios();
  };

  onTagFilterChange(): void {
    this.fetchScenarios();
  }

  async fetchScenarios(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const url = this.tagFilter ? `/api/scenarios?tag=${encodeURIComponent(this.tagFilter)}` : '/api/scenarios';
      const res = await fetch(url);
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

  async runNow(name: string): Promise<void> {
    this.running = name;
    this.cdr.detectChanges();
    try {
      await fetch(`/api/scenarios/${encodeURIComponent(name)}/run`, { method: 'POST' });
    } catch {
      // Ignore — the run will proceed server-side
    } finally {
      this.running = '';
      this.cdr.detectChanges();
    }
  }

  async togglePause(s: ScenarioInfo): Promise<void> {
    const action = s.paused ? 'resume' : 'pause';
    try {
      const res = await fetch(`/api/scenarios/${encodeURIComponent(s.name)}/${action}`, { method: 'POST' });
      if (res.ok) {
        s.paused = !s.paused;
        this.cdr.detectChanges();
      }
    } catch {
      // Ignore
    }
  }
}
