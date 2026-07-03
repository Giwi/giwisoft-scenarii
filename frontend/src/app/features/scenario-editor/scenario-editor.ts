import {
  Component,
  OnInit,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-scenario-editor',
  standalone: true,
  imports: [NgIf, FormsModule, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './scenario-editor.html',
  styleUrl: './scenario-editor.css',
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
      const res = await fetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/config`, { credentials: 'include' });
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
      const res = await fetch(`/api/scenarios/${encodeURIComponent(this.scenarioName)}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: this.yaml }),
        credentials: 'include',
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
