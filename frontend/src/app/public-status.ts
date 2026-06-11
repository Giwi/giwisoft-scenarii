import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgIf, NgFor } from '@angular/common';
import Chart from 'chart.js/auto';

interface HistoryEntry {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  success: boolean;
  steps: unknown[];
}

interface ScenarioStatus {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  sla: number;
  tags: string[];
  history: HistoryEntry[];
}

@Component({
  standalone: true,
  selector: 'app-public-status',
  imports: [NgIf, NgFor, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div *ngIf="error" class="text-center py-5 text-secondary">
      <i class="bi bi-search fs-2 mb-2 d-block"></i>
      Scenario not found.
    </div>

    <div class="text-center py-5 text-secondary" *ngIf="!scenario && !error">
      <i class="bi bi-hourglass-split fs-2 mb-2 d-block"></i>
      Loading...
    </div>

    <div *ngIf="scenario">
      <div class="d-flex align-items-center gap-2 mb-2">
        <h1 class="h4 mb-0">{{ scenario.name }}</h1>
        <span class="ms-2" *ngIf="scenario.tags.length">
          <span class="badge bg-info me-1" *ngFor="let tag of scenario.tags">{{ tag }}</span>
        </span>
      </div>
      <div class="small text-secondary mb-4">
        Status page — auto-refreshes every 30s
      </div>

      <div class="row g-3 mb-4">
        <div class="col">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold"
              [class.text-success]="scenario.last_success === 1"
              [class.text-danger]="scenario.last_success === 0"
              [class.text-secondary]="scenario.last_success === null"
            >{{ scenario.last_success === 1 ? 'Pass' : scenario.last_success === 0 ? 'Fail' : '—' }}</div>
            <div class="small text-secondary text-uppercase">Current Status</div>
          </div>
        </div>
        <div class="col">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold"
              [class.text-success]="scenario.sla >= 99"
              [class.text-warning]="scenario.sla >= 90 && scenario.sla < 99"
              [class.text-danger]="scenario.sla < 90"
            >{{ scenario.sla }}%</div>
            <div class="small text-secondary text-uppercase">SLA (7d)</div>
          </div>
        </div>
        <div class="col">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold">{{ scenario.total_runs }}</div>
            <div class="small text-secondary text-uppercase">Total Runs</div>
          </div>
        </div>
        <div class="col">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold text-success">{{ scenario.passed_runs }}</div>
            <div class="small text-secondary text-uppercase">Passed</div>
          </div>
        </div>
        <div class="col">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold text-danger">{{ scenario.failed_runs }}</div>
            <div class="small text-secondary text-uppercase">Failed</div>
          </div>
        </div>
      </div>

      <div class="row g-3 mb-4">
        <div class="col-md-6">
          <div class="card border-0 shadow-sm">
            <div class="card-body">
              <h3 class="card-title small text-secondary text-uppercase">Response Time Trend</h3>
              <div class="chart-wrapper"><canvas id="durationChart"></canvas></div>
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="card border-0 shadow-sm">
            <div class="card-body">
              <h3 class="card-title small text-secondary text-uppercase">Success Rate Over Time</h3>
              <div class="chart-wrapper"><canvas id="successChart"></canvas></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class PublicStatusComponent implements OnInit, OnDestroy {
  scenario: ScenarioStatus | null = null;
  error = false;
  private charts: Chart[] = [];
  private scenarioName = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.scenarioName = this.route.snapshot.paramMap.get('name')!;
    this.fetchStatus();
    this.pollTimer = setInterval(() => this.fetchStatus(), 30000);
  }

  ngOnDestroy(): void {
    this.charts.forEach(c => c.destroy());
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async fetchStatus(): Promise<void> {
    try {
      const res = await fetch(`/api/public/scenario/${encodeURIComponent(this.scenarioName)}?days=7`);
      if (res.ok) {
        this.scenario = await res.json();
        this.error = false;
        this.cdr.detectChanges();
        setTimeout(() => this.renderCharts(), 50);
      } else {
        this.error = true;
        this.cdr.detectChanges();
      }
    } catch {
      this.error = true;
      this.cdr.detectChanges();
    }
  }

  private renderCharts(): void {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
    if (!this.scenario || this.scenario.history.length === 0) return;

    const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    const gridColor = isDark ? '#4a5568' : '#e0e0e0';
    const textColor = isDark ? '#8b949e' : '#666';
    const accent = isDark ? '#00d4ff' : '#6366f1';
    const green = isDark ? '#3fb950' : '#10b981';

    const labels = this.scenario.history.map(r => new Date(r.started_at).toLocaleString()).reverse();
    const durations = this.scenario.history.map(r => r.duration_ms).reverse();

    this.charts.push(
      new Chart('durationChart', {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Duration (ms)',
            data: durations,
            borderColor: accent,
            backgroundColor: isDark ? 'rgba(0, 212, 255, 0.1)' : 'rgba(99, 102, 241, 0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } },
            y: { beginAtZero: true, ticks: { font: { size: 10 }, color: textColor }, grid: { color: gridColor } },
          },
        },
      }),
    );

    const successCounts = this.scenario.history.map(r => (r.success ? 1 : 0)).reverse();
    const runningAvg = this.runningAverage(successCounts, 5);

    this.charts.push(
      new Chart('successChart', {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Success',
            data: runningAvg,
            borderColor: green,
            backgroundColor: isDark ? 'rgba(63, 185, 80, 0.1)' : 'rgba(45, 198, 83, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } },
            y: { min: 0, max: 1, ticks: { font: { size: 10 }, color: textColor, callback: (v) => (v as number) * 100 + '%' }, grid: { color: gridColor } },
          },
        },
      }),
    );
  }

  private runningAverage(data: number[], window: number): number[] {
    return data.map((_, i) => {
      const start = Math.max(0, i - window + 1);
      const slice = data.slice(start, i + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
  }
}
