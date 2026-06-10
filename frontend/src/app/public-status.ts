import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgIf, NgFor, DatePipe } from '@angular/common';

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
  imports: [NgIf, NgFor, DatePipe, RouterModule],
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
          <span class="badge bg-info me-1" style="font-size:.7rem" *ngFor="let tag of scenario.tags">{{ tag }}</span>
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

      <div class="card border-0 shadow-sm">
        <div class="card-body">
          <h3 class="card-title small text-secondary text-uppercase mb-3">Last 20 Runs</h3>
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
                <tr *ngFor="let run of scenario.history">
                  <td class="small">{{ run.started_at | date:'MMM d, HH:mm:ss' }}</td>
                  <td class="font-monospace small">{{ run.duration_ms }}ms</td>
                  <td>
                    <span class="badge" [class.bg-success]="run.success" [class.bg-danger]="!run.success">
                      {{ run.success ? 'Pass' : 'Fail' }}
                    </span>
                  </td>
                  <td class="small">{{ run.steps.length }} steps</td>
                </tr>
                <tr *ngIf="!scenario.history.length">
                  <td colspan="4" class="text-center text-secondary small">No runs yet</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class PublicStatusComponent implements OnInit, OnDestroy {
  scenario: ScenarioStatus | null = null;
  error = false;
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
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async fetchStatus(): Promise<void> {
    try {
      const res = await fetch(`/api/public/scenario/${encodeURIComponent(this.scenarioName)}?days=7`);
      if (res.ok) {
        this.scenario = await res.json();
        this.error = false;
      } else {
        this.error = true;
      }
    } catch {
      this.error = true;
    }
    this.cdr.detectChanges();
  }
}
