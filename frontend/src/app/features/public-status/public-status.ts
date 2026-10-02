import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, inject } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgIf, NgFor } from '@angular/common';
import Chart from 'chart.js/auto';
import { I18nService } from '../../shared/i18n';

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
  templateUrl: './public-status.html',
  styleUrl: './public-status.css',
})
export class PublicStatusComponent implements OnInit, OnDestroy {
  scenario: ScenarioStatus | null = null;
  error = false;
  private charts: Chart[] = [];
  private scenarioName = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Translation helper, exposed so the template can call `t('key')`.
  readonly t = inject(I18nService).t;

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
            backgroundColor: areaGradient(accent),
            fill: true,
            tension: 0.3,
            borderWidth: 1.5,
            pointRadius: 2,
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
            backgroundColor: areaGradient(green),
            fill: true,
            tension: 0.3,
            borderWidth: 1.5,
            pointRadius: 2,
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
