import {
  Component,
  OnInit,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { apiFetch } from './api';

@Component({
  selector: 'app-scenario-editor',
  standalone: true,
  imports: [NgIf, FormsModule, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="d-flex align-items-center gap-2 mb-3">
      <a routerLink="/scenario/{{ scenarioName }}" class="btn btn-sm btn-outline-secondary">
        <i class="bi bi-arrow-left"></i>
      </a>
      <h1 class="h5 mb-0">Edit: {{ scenarioName }}</h1>
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-sm btn-outline-primary" (click)="createNew()" title="New scenario">
          <i class="bi bi-plus-lg"></i> New
        </button>
        <button class="btn btn-sm btn-success" (click)="save()" [disabled]="saving">
          <i class="bi bi-floppy me-1"></i>{{ saving ? 'Saving...' : 'Save' }}
        </button>
      </div>
    </div>

    <div class="alert alert-success" *ngIf="saved" role="alert">
      <i class="bi bi-check-circle me-1"></i> Scenario saved successfully.
    </div>
    <div class="alert alert-danger" *ngIf="error" role="alert">
      <i class="bi bi-exclamation-triangle me-1"></i> {{ error }}
    </div>

    <div class="card border-0 shadow-sm">
      <div class="card-body p-0">
        <textarea
          class="form-control border-0 font-monospace"
          [(ngModel)]="yaml"
          rows="30"
          spellcheck="false"
          style="font-size:.8rem;resize:vertical;min-height:60vh"
        ></textarea>
      </div>
    </div>
  `,
})
export class ScenarioEditorComponent implements OnInit {
  scenarioName = '';
  yaml = '';
  saving = false;
  saved = false;
  error = '';

  constructor(
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
  ) {}

  async ngOnInit(): Promise<void> {
    this.scenarioName = this.route.snapshot.paramMap.get('name') || '';
    if (!this.scenarioName) {
      this.yaml = this.emptyYaml();
      return;
    }
    await this.loadYaml();
  }

  async loadYaml(): Promise<void> {
    try {
      const res = await apiFetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/config`);
      if (res.ok) {
        this.yaml = await res.text();
      } else {
        this.error = 'Scenario not found on disk';
      }
    } catch {
      this.error = 'Failed to load scenario config';
    }
    this.cdr.detectChanges();
  }

  async save(): Promise<void> {
    this.saving = true;
    this.saved = false;
    this.error = '';
    this.cdr.detectChanges();
    try {
      const res = await apiFetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: this.yaml }),
      });
      if (res.ok) {
        this.saved = true;
        setTimeout(() => { this.saved = false; this.cdr.detectChanges(); }, 3000);
      } else {
        const data = await res.json();
        this.error = data.error || 'Save failed';
      }
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : 'Save failed';
    } finally {
      this.saving = false;
      this.cdr.detectChanges();
    }
  }

  createNew(): void {
    this.scenarioName = 'new-scenario';
    this.yaml = this.emptyYaml();
    this.error = '';
    this.saved = false;
    this.cdr.detectChanges();
  }

  private emptyYaml(): string {
    return `name: new-scenario
description: ""
schedule: "*/5 * * * *"
base_url: "https://example.com"
steps:
  - name: check_homepage
    action: http.get
    url: /
    expect:
      status: 200
`;
  }
}
