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
}

interface StepMetricsData {
  step_name: string;
  action: string;
  success: number;
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
  success: number;
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
    <div class="container" *ngIf="loading">
      <a routerLink="/" class="back">&larr; Back</a>
      <p class="empty">Loading...</p>
    </div>

    <div class="container" *ngIf="!loading && !detail">
      <a routerLink="/" class="back">&larr; Back</a>
      <p class="empty">Scenario not found.</p>
    </div>

    <div class="container" *ngIf="detail">
      <a routerLink="/" class="back">&larr; Back</a>

      <header>
        <h1>{{ detail.info.name }}</h1>
        <span class="badge" [class.success]="detail.info.last_success === 1" [class.fail]="detail.info.last_success === 0">
          {{ detail.info.last_success === 1 ? 'PASS' : 'FAIL' }}
        </span>
        <span class="meta">Total runs: {{ detail.info.total_runs }}</span>
      </header>

      <div class="charts-grid">
        <div class="chart-card">
          <h3>Response Time Trend (last {{ limitDays }} days)</h3>
          <div class="chart-wrapper"><canvas id="durationChart"></canvas></div>
        </div>

        <div class="chart-card">
          <h3>Success Rate Over Time</h3>
          <div class="chart-wrapper"><canvas id="successChart"></canvas></div>
        </div>
      </div>

      <div class="chart-card" *ngIf="detail.stepNames.length > 1">
        <h3>Step Response Times</h3>
        <div class="chart-wrapper"><canvas id="stepChart"></canvas></div>
      </div>

      <div class="chart-card">
        <h3>Recent Runs</h3>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let run of detail.history.slice(0, 50)">
              <td>{{ run.started_at | date:'MMM d, HH:mm:ss' }}</td>
              <td class="num">{{ run.duration_ms }}ms</td>
              <td>
                <span class="badge-sm" [class.success]="run.success === 1" [class.fail]="run.success === 0">
                  {{ run.success === 1 ? 'PASS' : 'FAIL' }}
                </span>
              </td>
              <td>
                <details>
                  <summary>{{ run.steps.length }} steps</summary>
                  <table class="sub">
                    <tr *ngFor="let step of run.steps">
                      <td>{{ step.step_name }}</td>
                      <td class="num">{{ step.response_time_ms }}ms</td>
                      <td>
                        <span class="badge-sm" [class.success]="step.success === 1" [class.fail]="step.success === 0">
                          {{ step.success === 1 ? 'OK' : 'ERR' }}
                        </span>
                      </td>
                      <td class="err" *ngIf="step.error"> {{ step.error }}</td>
                    </tr>
                  </table>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [`
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .back { display: inline-block; margin-bottom: 16px; color: #4361ee; text-decoration: none; font-size: 14px; }
    .back:hover { text-decoration: underline; }
    header { margin-bottom: 24px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 24px; color: #1a1a2e; }
    .meta { color: #666; font-size: 13px; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 13px; font-weight: 600; }
    .badge.success { background: #d4edda; color: #155724; }
    .badge.fail { background: #f8d7da; color: #721c24; }
    .badge-sm { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .badge-sm.success { background: #d4edda; color: #155724; }
    .badge-sm.fail { background: #f8d7da; color: #721c24; }
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .chart-card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px; }
    .chart-card h3 { margin: 0 0 16px; font-size: 14px; color: #666; }
    .chart-card.full { grid-column: 1 / -1; }
    .chart-wrapper { position: relative; height: 250px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; background: #f8f9fa; }
    .num { font-family: monospace; }
    .err { color: #dc3545; font-size: 12px; }
    details summary { cursor: pointer; color: #4361ee; font-size: 12px; }
    .sub { margin-top: 4px; }
    .sub td { padding: 4px 8px; font-size: 12px; }
  `]
})
export class ScenarioDetailComponent implements OnInit, OnDestroy {
  detail: ScenarioDetail | null = null;
  loading = true;
  limitDays = 7;
  private charts: Chart[] = [];

  constructor(private route: ActivatedRoute, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
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

  ngOnDestroy(): void {
    this.charts.forEach(c => c.destroy());
  }

  private renderCharts(): void {
    try {
      if (!this.detail) return;
      const history = this.detail.history;
      if (history.length === 0) return;

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
            borderColor: '#4361ee',
            backgroundColor: 'rgba(67, 97, 238, 0.1)',
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
            x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
            y: { beginAtZero: true }
          }
        }
      }));

      // Success rate chart
      const successCounts = history.map(r => r.success === 1 ? 1 : 0).reverse();
      const runningAvg = this.runningAverage(successCounts, 5);

      this.charts.push(new Chart('successChart', {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Success',
            data: runningAvg,
            borderColor: '#2dc653',
            backgroundColor: 'rgba(45, 198, 83, 0.1)',
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
            x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
            y: { min: 0, max: 1, ticks: { callback: (v) => (v as number) * 100 + '%' } }
          }
        }
      }));

      // Step response time chart (if multiple steps)
      if (this.detail.stepNames.length > 1) {
        const stepColors = ['#4361ee', '#2dc653', '#e63946', '#f77f00', '#8338ec', '#ff006e'];
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
            plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } },
            scales: {
              x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
              y: { beginAtZero: true }
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
