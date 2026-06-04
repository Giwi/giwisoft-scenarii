import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgFor, NgIf, DatePipe } from '@angular/common';
import Chart from 'chart.js/auto';

interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  pass_rate: number;
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
  template: `
    <div class="d-flex align-items-center gap-2 mb-3">
      <a routerLink="/" class="btn btn-sm btn-outline-secondary">
        <i class="bi bi-arrow-left"></i>
      </a>
      <button class="btn btn-sm btn-outline-primary" (click)="refresh()" [disabled]="loading">
        <i class="bi bi-arrow-clockwise"></i>
      </button>
    </div>

    <div class="d-flex align-items-center gap-3 mb-4 flex-wrap">
      <h1 class="h4 mb-0">{{ detail?.info?.name }}</h1>
      <span class="small text-secondary" *ngIf="detail">
        <span class="fw-semibold">{{ detail.info.total_runs }}</span> runs ·
        <span class="text-success fw-semibold">{{ detail.info.passed_runs }}</span> passed ·
        <span class="text-danger fw-semibold">{{ detail.info.failed_runs }}</span> failed ·
        <span class="fw-semibold">{{ detail.info.pass_rate }}%</span>
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

    <ng-container *ngIf="detail">
      <div class="row g-3 mb-4">
        <div class="col-md-6">
          <div class="card border-0 shadow-sm">
            <div class="card-body">
              <h3 class="card-title small text-secondary text-uppercase">Response Time Trend ({{ limitDays }}d)</h3>
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
                  <td class="small">{{ run.started_at | date:'MMM d, HH:mm:ss' }}</td>
                  <td class="font-monospace small">{{ run.duration_ms }}ms</td>
                  <td>
                    <span class="badge" [class.bg-success]="run.success" [class.bg-danger]="!run.success">
                      {{ run.success ? 'Pass' : 'Fail' }}
                    </span>
                  </td>
                  <td>
                    <details>
                      <summary class="text-primary small" style="cursor:pointer">{{ run.steps.length }} steps</summary>
                      <table class="table table-sm mt-2 mb-0">
                        <tr *ngFor="let step of run.steps">
                          <td class="small">{{ step.step_name }}</td>
                          <td class="font-monospace small">{{ step.response_time_ms }}ms</td>
                          <td>
                            <span class="badge bg-success" *ngIf="step.success">OK</span>
                            <span class="badge bg-danger" *ngIf="!step.success">ERR</span>
                          </td>
                          <td class="text-danger small" *ngIf="step.error">{{ step.error }}</td>
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
  limitDays = 7;
  private charts: Chart[] = [];

  constructor(private route: ActivatedRoute, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    await this.loadDetail();
  }

  ngOnDestroy(): void {
    this.charts.forEach(c => c.destroy());
  }

  async refresh(): Promise<void> {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
    this.loading = true;
    this.cdr.detectChanges();
    await this.loadDetail();
  }

  private async loadDetail(): Promise<void> {
    const name = this.route.snapshot.paramMap.get('name')!;
    try {
      const res = await fetch(`/api/scenarios/${encodeURIComponent(name)}`);
      if (res.ok) {
        this.detail = await res.json();
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
      const gridColor = isDark ? '#30363d' : '#e0e0e0';
      const textColor = isDark ? '#8b949e' : '#666';
      const accent = isDark ? '#58a6ff' : '#4361ee';
      const green = isDark ? '#3fb950' : '#2dc653';

      // Duration trend chart
      const labels = history.map(r => new Date(r.started_at).toLocaleString()).reverse();
      const durations = history.map(r => r.duration_ms).reverse();

      this.charts.push(new Chart('durationChart', {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Duration (ms)',
            data: durations,
            borderColor: accent,
            backgroundColor: isDark ? 'rgba(88, 166, 255, 0.1)' : 'rgba(67, 97, 238, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } },
            y: { beginAtZero: true, ticks: { font: { size: 10 }, color: textColor }, grid: { color: gridColor } }
          }
        }
      }));

      // Success rate chart
      const successCounts = history.map(r => r.success ? 1 : 0).reverse();
      const runningAvg = this.runningAverage(successCounts, 5);

      this.charts.push(new Chart('successChart', {
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
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } },
            y: { min: 0, max: 1, ticks: { font: { size: 10 }, color: textColor, callback: (v) => (v as number) * 100 + '%' }, grid: { color: gridColor } }
          }
        }
      }));

      // Step response time chart (if multiple steps)
      if (this.detail.stepNames.length > 1) {
        const stepColors = isDark
          ? ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#f778ba']
          : ['#4361ee', '#2dc653', '#e63946', '#f77f00', '#8338ec', '#ff006e'];
        const datasets = this.detail.stepNames.map((stepName, i) => {
          const data = history.map(run => {
            const step = run.steps.find(s => s.step_name === stepName);
            return step ? step.response_time_ms : 0;
          }).reverse();
          return {
            label: stepName,
            data,
            borderColor: stepColors[i % stepColors.length],
            tension: 0.3,
            pointRadius: 2,
          };
        });

        this.charts.push(new Chart('stepChart', {
          type: 'line',
          data: { labels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, color: textColor } } },
            scales: {
              x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } },
              y: { beginAtZero: true, ticks: { font: { size: 10 }, color: textColor }, grid: { color: gridColor } }
            }
          }
        }));
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
