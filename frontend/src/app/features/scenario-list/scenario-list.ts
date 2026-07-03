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
import { onScenarioRun, removeScenarioRunListener, ScenarioRunEvent } from '../../shared/ws';
import { apiFetch } from '../../shared/api';

interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  paused?: boolean;
  scheduled?: boolean;
  tags?: string[];
  depends_on?: string;
  group?: string;
}

@Component({
  selector: 'app-scenario-list',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, DatePipe, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './scenario-list.html',
  styleUrl: './scenario-list.css',
})
export class ScenarioListComponent implements OnInit, OnDestroy {
  scenarios: ScenarioInfo[] = [];
  loading = true;
  running = '';
  cancelling = '';
  tagFilter = '';
  groupFilter = '';
  allTags: string[] = [];
  allGroups: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  fetching = false;

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

  async fetchScenarios(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const params = new URLSearchParams();
      if (this.tagFilter) params.set('tag', this.tagFilter);
      if (this.groupFilter) params.set('group', this.groupFilter);
      const qs = params.toString();
      const url = qs ? `/api/scenarios?${qs}` : '/api/scenarios';
      const [scenariosRes, tagsRes, groupsRes] = await Promise.all([
        apiFetch(url),
        apiFetch('/api/tags'),
        apiFetch('/api/groups'),
      ]);
      if (scenariosRes.ok) {
        this.scenarios = await scenariosRes.json();
      }
      if (tagsRes.ok) {
        this.allTags = await tagsRes.json();
      }
      if (groupsRes.ok) {
        this.allGroups = await groupsRes.json();
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
      await apiFetch(`/api/scenarios/${encodeURIComponent(name)}/run`, { method: 'POST' });
    } catch {
      // Ignore — the run will proceed server-side
    } finally {
      this.running = '';
      this.cdr.detectChanges();
    }
  }

  async cancelRun(name: string): Promise<void> {
    this.cancelling = name;
    this.cdr.detectChanges();
    try {
      await apiFetch(`/api/scenarios/${encodeURIComponent(name)}/cancel`, { method: 'POST' });
    } catch {
      // Ignore
    } finally {
      this.cancelling = '';
      this.cdr.detectChanges();
    }
  }

  async togglePause(s: ScenarioInfo): Promise<void> {
    const action = s.paused ? 'resume' : 'pause';
    try {
      const res = await apiFetch(`/api/scenarios/${encodeURIComponent(s.name)}/${action}`, { method: 'POST' });
      if (res.ok) {
        s.paused = !s.paused;
        this.cdr.detectChanges();
      }
    } catch {
      // Ignore
    }
  }
}
