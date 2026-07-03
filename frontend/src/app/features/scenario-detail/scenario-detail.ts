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
import { onScenarioRun, removeScenarioRunListener, onStepProgress, removeStepProgressListener } from '../../shared/ws';

function areaGradient(color: string, alphaTop = 0.25, alphaBottom = 0.02) {
  return (ctx: any) => {
    const chart = ctx.chart;
    const { ctx: canvasCtx, chartArea } = chart;
    if (!chartArea) return null;
    const grad = canvasCtx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    grad.addColorStop(0, `rgba(${r},${g},${b},${alphaBottom})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},${alphaTop})`);
    return grad;
  };
}

interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  depends_on?: string;
  tags: string[];
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
  templateUrl: './scenario-detail.html',
  styleUrl: './scenario-detail.css',
})
export class ScenarioDetailComponent implements OnInit, OnDestroy {
  detail: ScenarioDetail | null = null;
  loading = true;
  running = false;
  sla = 100;
  isRunning = false;
  tickerStep = '';
  tickerResponseTime: number | null = null;
  tickerError: string | null = null;
  tickerStatus: 'idle' | 'running' | 'done' | 'error' = 'idle';
  copied = false;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private charts: Chart[] = [];
  scenarioName = '';
  pageSize = 15;
  currentPage = 1;

  get totalPages(): number {
    return Math.max(1, Math.ceil(Math.min(this.detail?.info.total_runs ?? 0, this.detail?.history.length ?? 0) / this.pageSize));
  }

  get displayedRuns(): ScenarioRun[] {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.detail?.history.slice(start, start + this.pageSize) ?? [];
  }

  get pageNumbers(): number[] {
    const total = this.totalPages;
    const current = this.currentPage;
    const maxVisible = 7;
    if (total <= maxVisible) return Array.from({ length: total }, (_, i) => i + 1);
    const pages: number[] = [];
    let start = Math.max(1, current - Math.floor(maxVisible / 2));
    let end = start + maxVisible - 1;
    if (end > total) { end = total; start = Math.max(1, end - maxVisible + 1); }
    if (start > 1) { pages.push(1); if (start > 2) pages.push(-1); }
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < total) { if (end < total - 1) pages.push(-1); pages.push(total); }
    return pages;
  }

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
    this.loading = true;
    this.cdr.detectChanges();
    await this.loadDetail();
  }

  private wsCallback = (event: import('../../shared/ws').ScenarioRunEvent) => {
    this.isRunning = false;
    this.tickerStatus = 'idle';
    if (event.scenario_name === this.scenarioName && !this.loading) {
      this.reloadData();
    }
  };

  private stepLogCallback = (event: import('../../shared/ws').StepProgressEvent) => {
    if (event.scenario_name !== this.scenarioName) return;
    this.isRunning = true;
    if (event.status === 'running') {
      this.tickerStep = event.step_name;
      this.tickerStatus = 'running';
      this.tickerResponseTime = null;
      this.tickerError = null;
    } else {
      this.tickerStep = event.step_name;
      this.tickerStatus = event.status === 'done' ? 'done' : 'error';
      this.tickerResponseTime = event.response_time_ms ?? null;
      this.tickerError = event.error ?? null;
    }
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
      await fetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/run`, { method: 'POST', credentials: 'include' });
    } catch {
      // Ignore
    } finally {
      this.running = false;
      this.cdr.detectChanges();
    }
  }

  async cancelRun(): Promise<void> {
    try {
      await fetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/cancel`, { method: 'POST', credentials: 'include' });
    } catch {
      // Ignore
    }
    this.cdr.detectChanges();
  }

  async copyPublicLink(): Promise<void> {
    const url = window.location.origin + '/public/status/' + encodeURIComponent(this.scenarioName);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    this.copied = true;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => { this.copied = false; this.cdr.detectChanges(); }, 2000);
    this.cdr.detectChanges();
  }

  async goToPage(page: number): Promise<void> {
    if (page < 1 || page > this.totalPages || page === this.currentPage) return;
    this.currentPage = page;
    this.cdr.detectChanges();
  }

  private async reloadData(): Promise<void> {
    const name = this.scenarioName;
    try {
      const [detailRes, slaRes] = await Promise.all([
        fetch(`/api/scenarios/${encodeURIComponent(name)}?days=7&limit=10000`, { credentials: 'include' }),
        fetch(`/api/scenarios/${encodeURIComponent(name)}/sla?days=7`, { credentials: 'include' }),
      ]);
      if (detailRes.ok) {
        this.detail = await detailRes.json();
      }
      if (slaRes.ok) {
        const slaData = await slaRes.json();
        this.sla = slaData.sla;
      }
      if (detailRes.ok || slaRes.ok) {
        this.updateCharts();
        this.cdr.detectChanges();
      }
    } catch (err) {
      console.error('Failed to reload scenario data', err);
    }
  }

  private async loadDetail(): Promise<void> {
    const name = this.scenarioName;
    try {
      const [detailRes, slaRes] = await Promise.all([
        fetch(`/api/scenarios/${encodeURIComponent(name)}?days=7&limit=10000`, { credentials: 'include' }),
        fetch(`/api/scenarios/${encodeURIComponent(name)}/sla?days=7`, { credentials: 'include' }),
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

  private updateCharts(): void {
    if (this.charts.length === 0) {
      setTimeout(() => this.renderCharts(), 100);
      return;
    }
    if (!this.detail || this.detail.history.length === 0) return;
    const history = this.detail.history;
    const labels = history.map((r) => new Date(r.started_at).toLocaleString()).reverse();

    const durations = history.map((r) => r.duration_ms).reverse();
    this.charts[0].data.labels = labels;
    this.charts[0].data.datasets[0].data = durations;
    this.charts[0].update('none');

    const successCounts = history.map((r) => (r.success ? 1 : 0)).reverse();
    const runningAvg = this.runningAverage(successCounts, 5);
    this.charts[1].data.labels = labels;
    this.charts[1].data.datasets[0].data = runningAvg;
    this.charts[1].update('none');

    if (this.charts.length > 2 && this.detail.stepNames.length > 1) {
      this.charts[2].data.labels = labels;
      this.detail.stepNames.forEach((stepName, i) => {
        const data = history
          .map((run) => {
            const step = run.steps.find((s) => s.step_name === stepName);
            return step ? step.response_time_ms : 0;
          })
          .reverse();
        if (this.charts[2].data.datasets[i]) {
          this.charts[2].data.datasets[i].data = data;
        }
      });
      this.charts[2].update('none');
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
                backgroundColor: areaGradient(accent),
                fill: true,
                tension: 0.3,
                borderWidth: 1.5,
                pointRadius: 2,
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
                backgroundColor: areaGradient(green),
                fill: true,
                tension: 0.3,
                borderWidth: 1.5,
                pointRadius: 2,
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
            backgroundColor: areaGradient(stepColors[i % stepColors.length], 0.15, 0.01),
            fill: true,
            tension: 0.3,
            borderWidth: 1.5,
            pointRadius: 1.5,
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
