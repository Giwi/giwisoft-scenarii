import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgFor, NgIf, DatePipe } from '@angular/common';
import Chart from 'chart.js/auto';
import { onScenarioRun, removeScenarioRunListener, onStepProgress, removeStepProgressListener } from './ws';
import { apiFetch } from './api';

interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  pass_rate: number;
  depends_on?: string;
}

interface StepMetricsData {
  step_name: string;
  action: string;
  success: boolean;
  status_code: number | null;
  response_time_ms: number;
  error: string | null;
  timestamp: string;
}

interface ScenarioRun {
  scenario_name: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  success: boolean;
  steps: StepMetricsData[];
}

interface ScenarioDetail {
  info: ScenarioInfo;
  history: ScenarioRun[];
  stepNames: string[];
}

@Component({
  selector: 'app-scenario-detail',
  standalone: true,
  imports: [NgFor, NgIf, DatePipe, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="d-flex align-items-center gap-2 mb-3">
      <a routerLink="/" class="btn btn-sm btn-outline-secondary">
        <i class="bi bi-arrow-left"></i>
      </a>
      <button class="btn btn-sm btn-outline-primary" (click)="refresh()" [disabled]="loading">
        <i class="bi bi-arrow-clockwise"></i>
      </button>
      <button class="btn btn-sm btn-outline-success" (click)="runNow()" [disabled]="running" title="Run now">
        <i class="bi bi-send-fill"></i>{{ running ? '...' : '' }}
      </button>
      <button class="btn btn-sm btn-outline-danger" (click)="cancelRun()" *ngIf="cancelling" disabled title="Cancelling...">
        <i class="bi bi-stop-fill"></i>
      </button>
      <div class="ms-auto" *ngIf="detail">
        <div class="dropdown">
          <button class="btn btn-sm btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown">
            <i class="bi bi-download me-1"></i>Export
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><a class="dropdown-item" [href]="exportUrl('json')" target="_blank"><i class="bi bi-filetype-json me-2"></i>JSON</a></li>
            <li><a class="dropdown-item" [href]="exportUrl('csv')" target="_blank"><i class="bi bi-filetype-csv me-2"></i>CSV</a></li>
            <li><a class="dropdown-item" [href]="configUrl()" target="_blank"><i class="bi bi-filetype-yml me-2"></i>YAML</a></li>
          </ul>
        </div>
      </div>
    </div>

    <div class="d-flex align-items-center gap-3 mb-4 flex-wrap">
      <h1 class="h4 mb-0">{{ detail?.info?.name }}</h1>
      <span class="small text-secondary" *ngIf="detail">
        <span class="fw-semibold">{{ detail.info.total_runs }}</span> runs ·
        <span class="text-success fw-semibold">{{ detail.info.passed_runs }}</span> passed ·
        <span class="text-danger fw-semibold">{{ detail.info.failed_runs }}</span> failed ·
        <span class="fw-semibold">{{ detail.info.pass_rate }}%</span>
        <span class="ms-2" *ngIf="detail.info.depends_on">· depends on <span class="fw-semibold">{{ detail.info.depends_on }}</span></span>
      </span>
    </div>

    <div class="text-center py-5 text-secondary" *ngIf="loading">
      <i class="bi bi-hourglass-split fs-2 mb-2 d-block"></i>
      Loading...
    </div>

    <div class="text-center py-5 text-secondary" *ngIf="!loading && !detail">
      <i class="bi bi-search fs-2 mb-2 d-block"></i>
      Scenario not found.
    </div>

    <div class="card border-0 shadow-sm mb-4" *ngIf="logs.length">
      <div class="card-body py-2" style="max-height:200px;overflow-y:auto">
        <div *ngFor="let log of logs" class="small">
          <span class="text-secondary me-2">{{ log.timestamp | date:'HH:mm:ss' }}</span>
          <i class="bi me-1"
            [class.bi-play-circle-fill]="log.status==='running'"
            [class.bi-check-circle-fill]="log.status==='done'"
            [class.bi-x-circle-fill]="log.status==='error'"
            [class.text-primary]="log.status==='running'"
            [class.text-success]="log.status==='done'"
            [class.text-danger]="log.status==='error'"
          ></i>
          <span>{{ log.step_name }}</span>
          <span class="text-secondary ms-1">{{ log.response_time_ms ? log.response_time_ms + 'ms' : '' }}</span>
          <span class="text-danger ms-1" *ngIf="log.error">{{ log.error }}</span>
        </div>
      </div>
    </div>

    <ng-container *ngIf="detail">
      <div class="row g-3 mb-4">
        <div class="col-md-3">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold" [class.text-success]="sla >= 99" [class.text-warning]="sla >= 90 && sla < 99" [class.text-danger]="sla < 90">{{ sla }}%</div>
            <div class="small text-secondary text-uppercase">SLA (7 days)</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold">{{ detail.info.pass_rate }}%</div>
            <div class="small text-secondary text-uppercase">Pass Rate</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold">{{ detail.info.total_runs }}</div>
            <div class="small text-secondary text-uppercase">Total Runs</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card border-0 shadow-sm text-center p-3">
            <div class="fs-2 fw-bold" [class.text-danger]="detail.info.failed_runs > 0">{{ detail.info.failed_runs }}</div>
            <div class="small text-secondary text-uppercase">Failed Runs</div>
          </div>
        </div>
      </div>
      <div class="row g-3 mb-4">
        <div class="col-md-6">
          <div class="card border-0 shadow-sm">
            <div class="card-body">
              <h3 class="card-title small text-secondary text-uppercase">
                Response Time Trend
              </h3>
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

      <div class="card border-0 shadow-sm mb-4" *ngIf="detail.stepNames.length > 1">
        <div class="card-body">
          <h3 class="card-title small text-secondary text-uppercase">Step Response Times</h3>
          <div class="chart-wrapper"><canvas id="stepChart"></canvas></div>
        </div>
      </div>

      <div class="card border-0 shadow-sm">
        <div class="card-body">
          <h3 class="card-title small text-secondary text-uppercase mb-3">Recent Runs</h3>
          <div class="table-responsive">
            <table class="table table-hover table-sm mb-0">
              <thead class="table-light">
                <tr>
                  <th>Time</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Steps</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let run of detail.history.slice(0, 50)">
                  <td class="small">{{ run.started_at | date: 'MMM d, HH:mm:ss' }}</td>
                  <td class="font-monospace small">{{ run.duration_ms }}ms</td>
                  <td>
                    <span
                      class="badge"
                      [class.bg-success]="run.success"
                      [class.bg-danger]="!run.success"
                    >
                      {{ run.success ? 'Pass' : 'Fail' }}
                    </span>
                  </td>
                  <td>
                    <details>
                      <summary class="text-primary small" style="cursor:pointer">
                        {{ run.steps.length }} steps
                      </summary>
                      <table class="table table-sm mt-2 mb-0" style="font-size: .75rem">
                        <tr *ngFor="let step of run.steps" class="align-top">
                          <td class="py-0 ps-0 pe-2 border-0">{{ step.step_name }}</td>
                          <td class="font-monospace py-0 px-2 border-0 text-nowrap">
                            {{ step.response_time_ms }}ms
                          </td>
                          <td class="py-0 px-2 border-0">
                            <span
                              class="badge bg-success"
                              *ngIf="step.success"
                              style="font-size: .65rem"
                              >OK</span
                            >
                            <span
                              class="badge bg-danger"
                              *ngIf="!step.success"
                              style="font-size: .65rem"
                              >ERR</span
                            >
                          </td>
                          <td
                            class="text-danger py-0 ps-2 pe-0 border-0"
                            *ngIf="step.error"
                            style="font-size: .65rem"
                          >
                            {{ step.error }}
                          </td>
                        </tr>
                      </table>
                    </details>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ng-container>
  `,
})
export class ScenarioDetailComponent implements OnInit, OnDestroy {
  detail: ScenarioDetail | null = null;
  loading = true;
  running = false;
  cancelling = false;
  sla = 100;
  logs: Array<{ step_name: string; status: string; response_time_ms?: number; error?: string; timestamp: Date }> = [];
  private charts: Chart[] = [];
  private scenarioName = '';

  constructor(
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
  ) {}

  async ngOnInit(): Promise<void> {
    this.scenarioName = this.route.snapshot.paramMap.get('name')!;
    await this.loadDetail();
    onScenarioRun(this.wsCallback);
    onStepProgress(this.stepLogCallback);
  }

  ngOnDestroy(): void {
    this.charts.forEach((c) => c.destroy());
    removeScenarioRunListener(this.wsCallback);
    removeStepProgressListener(this.stepLogCallback);
  }

  async refresh(): Promise<void> {
    this.charts.forEach((c) => c.destroy());
    this.charts = [];
    this.logs = [];
    this.loading = true;
    this.cdr.detectChanges();
    await this.loadDetail();
  }

  private wsCallback = (event: import('./ws').ScenarioRunEvent) => {
    if (event.scenario_name === this.scenarioName && !this.loading) {
      this.refresh();
    }
  };

  private stepLogCallback = (event: import('./ws').StepProgressEvent) => {
    if (event.scenario_name !== this.scenarioName) return;
    if (event.status === 'running') {
      this.logs.push({ step_name: event.step_name, status: 'running', timestamp: new Date() });
    } else {
      let found = false;
      for (let i = this.logs.length - 1; i >= 0; i--) {
        if (this.logs[i].step_name === event.step_name && this.logs[i].status === 'running') {
          this.logs[i].status = event.status;
          this.logs[i].response_time_ms = event.response_time_ms;
          this.logs[i].error = event.error;
          found = true;
          break;
        }
      }
      if (!found) {
        this.logs.push({ step_name: event.step_name, status: event.status, response_time_ms: event.response_time_ms, error: event.error, timestamp: new Date() });
      }
    }
    if (this.logs.length > 100) this.logs = this.logs.slice(-100);
    this.cdr.detectChanges();
  };

  exportUrl(format: string): string {
    return `/api/scenarios/${encodeURIComponent(this.scenarioName)}/export/${format}`;
  }

  configUrl(): string {
    return `/api/scenarios/${encodeURIComponent(this.scenarioName)}/config`;
  }

  async runNow(): Promise<void> {
    this.running = true;
    this.cdr.detectChanges();
    try {
      await apiFetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/run`, { method: 'POST' });
    } catch {
      // Ignore
    } finally {
      this.running = false;
      this.cdr.detectChanges();
    }
  }

  async cancelRun(): Promise<void> {
    this.cancelling = true;
    this.cdr.detectChanges();
    try {
      await apiFetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/cancel`, { method: 'POST' });
    } catch {
      // Ignore
    } finally {
      this.cancelling = false;
      this.cdr.detectChanges();
    }
  }

  private async loadDetail(): Promise<void> {
    const name = this.scenarioName;
    try {
      const [detailRes, slaRes] = await Promise.all([
        apiFetch(`/api/scenarios/${encodeURIComponent(name)}?days=7`),
        apiFetch(`/api/scenarios/${encodeURIComponent(name)}/sla?days=7`),
      ]);
      if (detailRes.ok) {
        this.detail = await detailRes.json();
      }
      if (slaRes.ok) {
        const slaData = await slaRes.json();
        this.sla = slaData.sla;
      }
      if (detailRes.ok || slaRes.ok) {
        this.cdr.detectChanges();
        setTimeout(() => this.renderCharts(), 100);
      }
    } catch (err) {
      console.error('Failed to load scenario detail', err);
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  private renderCharts(): void {
    try {
      if (!this.detail) return;
      const history = this.detail.history;
      if (history.length === 0) return;

      const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
      const gridColor = isDark ? '#4a5568' : '#e0e0e0';
      const textColor = isDark ? '#8b949e' : '#666';
      const accent = isDark ? '#00d4ff' : '#6366f1';
      const green = isDark ? '#3fb950' : '#10b981';

      // Duration trend chart
      const labels = history.map((r) => new Date(r.started_at).toLocaleString()).reverse();
      const durations = history.map((r) => r.duration_ms).reverse();

      this.charts.push(
        new Chart('durationChart', {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Duration (ms)',
                data: durations,
                borderColor: accent,
                backgroundColor: isDark ? 'rgba(0, 212, 255, 0.1)' : 'rgba(99, 102, 241, 0.08)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: {
                ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor },
                grid: { color: gridColor },
              },
              y: {
                beginAtZero: true,
                ticks: { font: { size: 10 }, color: textColor },
                grid: { color: gridColor },
              },
            },
          },
        }),
      );

      // Success rate chart
      const successCounts = history.map((r) => (r.success ? 1 : 0)).reverse();
      const runningAvg = this.runningAverage(successCounts, 5);

      this.charts.push(
        new Chart('successChart', {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Success',
                data: runningAvg,
                borderColor: green,
                backgroundColor: isDark ? 'rgba(63, 185, 80, 0.1)' : 'rgba(45, 198, 83, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: {
                ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor },
                grid: { color: gridColor },
              },
              y: {
                min: 0,
                max: 1,
                ticks: {
                  font: { size: 10 },
                  color: textColor,
                  callback: (v) => (v as number) * 100 + '%',
                },
                grid: { color: gridColor },
              },
            },
          },
        }),
      );

      // Step response time chart (if multiple steps)
      if (this.detail.stepNames.length > 1) {
        const stepColors = isDark
          ? ['#00d4ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#f778ba']
          : ['#6366f1', '#10b981', '#f43f5e', '#f59e0b', '#a855f7', '#ec4899'];
        const datasets = this.detail.stepNames.map((stepName, i) => {
          const data = history
            .map((run) => {
              const step = run.steps.find((s) => s.step_name === stepName);
              return step ? step.response_time_ms : 0;
            })
            .reverse();
          return {
            label: stepName,
            data,
            borderColor: stepColors[i % stepColors.length],
            tension: 0.3,
            pointRadius: 2,
          };
        });

        this.charts.push(
          new Chart('stepChart', {
            type: 'line',
            data: { labels, datasets },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: 'bottom', labels: { font: { size: 10 }, color: textColor } },
              },
              scales: {
                x: {
                  ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor },
                  grid: { color: gridColor },
                },
                y: {
                  beginAtZero: true,
                  ticks: { font: { size: 10 }, color: textColor },
                  grid: { color: gridColor },
                },
              },
            },
          }),
        );
      }
    } catch (err) {
      console.error('Failed to render charts', err);
    }
  }

  private runningAverage(data: number[], window: number): number[] {
    return data.map((_, i) => {
      const start = Math.max(0, i - window + 1);
      const slice = data.slice(start, i + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
  }
}
