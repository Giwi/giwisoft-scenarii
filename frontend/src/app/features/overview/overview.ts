import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, inject } from '@angular/core';
import { NgFor, NgIf, DecimalPipe, NgClass } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../shared/i18n';
import { onScenarioRun, removeScenarioRunListener } from '../../shared/ws';

interface DailyPassRate {
  date: string;
  total: number;
  passed: number;
}

interface ScenarioStat {
  name: string;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  flaky_runs: number;
  avg_ms: number;
  p95_ms: number;
}

interface OverviewData {
  days: number;
  totals: { runs: number; passed: number; failed: number; flaky: number };
  daily: DailyPassRate[];
  slowest: ScenarioStat[];
  flakiest: ScenarioStat[];
}

interface HeatCell {
  date: string;
  total: number;
  passed: number;
  level: number;
  empty?: boolean;
}

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [NgFor, NgIf, RouterModule, FormsModule, DecimalPipe, NgClass],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './overview.html',
  styleUrl: './overview.css',
})
export class OverviewComponent implements OnInit, OnDestroy {
  readonly i18n = inject(I18nService);
  readonly t = this.i18n.t;

  data: OverviewData | null = null;
  loading = true;
  days = 30;
  tags: string[] = [];
  groups: string[] = [];
  selectedTag = '';
  selectedGroup = '';
  busy = false;
  actionMessage = '';

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  get passRate(): number {
    const totals = this.data?.totals;
    if (!totals || totals.runs === 0) return 0;
    return (totals.passed / totals.runs) * 100;
  }

  // Seven rows (one per weekday), each holding one cell per week. Aligns the
  // final day of the window with today's weekday.
  get heatmapRows(): HeatCell[][] {
    const daily = this.data?.daily ?? [];
    if (daily.length === 0) return [];
    const rows: HeatCell[][] = Array.from({ length: 7 }, () => []);
    const firstWeekday = new Date(`${daily[0].date}T00:00:00Z`).getUTCDay();
    for (const day of daily) {
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      rows[weekday].push(this.toCell(day));
    }
    // Days before the window start leave a gap in the first week column.
    for (let weekday = 0; weekday < firstWeekday; weekday++) {
      rows[weekday].unshift({ date: '', total: 0, passed: 0, level: 0, empty: true });
    }
    return rows;
  }

  get weekdayLabels(): string[] {
    return ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  }

  private toCell(day: DailyPassRate): HeatCell {
    let level = 0;
    if (day.total > 0) {
      const rate = day.passed / day.total;
      level = rate >= 1 ? 4 : rate >= 0.95 ? 3 : rate >= 0.8 ? 2 : rate >= 0.5 ? 1 : 0;
      if (level === 0) level = 1;
    }
    return { date: day.date, total: day.total, passed: day.passed, level };
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.load(), this.loadFilters()]);
    this.pollTimer = setInterval(() => { void this.load(); }, 30000);
    onScenarioRun(this.wsCallback);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    removeScenarioRunListener(this.wsCallback);
  }

  private wsCallback = () => { void this.load(); };

  async load(): Promise<void> {
    try {
      const res = await fetch(`/api/overview?days=${this.days}`, { credentials: 'include' });
      if (res.ok) this.data = await res.json();
    } catch {
      // Retry on the next poll.
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  private async loadFilters(): Promise<void> {
    try {
      const [tagsRes, groupsRes] = await Promise.all([
        fetch('/api/tags', { credentials: 'include' }),
        fetch('/api/groups', { credentials: 'include' }),
      ]);
      if (tagsRes.ok) this.tags = await tagsRes.json();
      if (groupsRes.ok) this.groups = await groupsRes.json();
    } catch {
      // Filters are optional.
    }
    this.cdr.detectChanges();
  }

  async setDays(days: number): Promise<void> {
    this.days = days;
    this.loading = true;
    this.cdr.detectChanges();
    await this.load();
  }

  get hasBulkTarget(): boolean {
    return !!this.selectedTag || !!this.selectedGroup;
  }

  async bulk(action: 'run' | 'pause' | 'resume'): Promise<void> {
    if (!this.hasBulkTarget || this.busy) return;
    this.busy = true;
    this.actionMessage = '';
    this.cdr.detectChanges();
    try {
      const body: Record<string, string> = {};
      if (this.selectedTag) body['tag'] = this.selectedTag;
      if (this.selectedGroup) body['group'] = this.selectedGroup;
      const res = await fetch(`/api/scenarios/bulk/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.actionMessage = payload.error || `HTTP ${res.status}`;
      } else if (action === 'run') {
        this.actionMessage = this.t('overview.bulk_run_done', { triggered: payload.triggered ?? 0 });
      } else {
        this.actionMessage = this.t('overview.bulk_state_done', { changed: payload.paused ?? payload.resumed ?? 0 });
      }
      await this.load();
    } catch {
      this.actionMessage = this.t('overview.bulk_failed');
    } finally {
      this.busy = false;
      this.cdr.detectChanges();
    }
  }

  rate(stat: ScenarioStat): number {
    return stat.total_runs === 0 ? 0 : (stat.passed_runs / stat.total_runs) * 100;
  }

  flakyRate(stat: ScenarioStat): number {
    return stat.total_runs === 0 ? 0 : (stat.flaky_runs / stat.total_runs) * 100;
  }
}
