import {
  Component,
  OnInit,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';

// One highlighted chunk of the YAML, rendered as a span over the textarea.
interface YamlPart {
  text: string;
  cls: string;
}

// Matches, in priority order: comments, quoted strings, booleans/null/numbers, mapping keys
// and list dashes. Anything unmatched stays plain text.
const YAML_TOKENS =
  /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b)|(^[\t ]*-?[\t ]*[A-Za-z_][\w.-]*(?=[\t ]*:))|(-(?=[\t ]))/gm;

const TOKEN_CLASSES = ['y-cmt', 'y-str', 'y-lit', 'y-key', 'y-dash'];

// Splits YAML into highlighted parts. Plain regex highlighting, no dependency needed.
export function highlightYaml(source: string): YamlPart[] {
  const parts: YamlPart[] = [];
  let last = 0;
  for (const match of source.matchAll(YAML_TOKENS)) {
    const index = match.index!;
    if (index > last) parts.push({ text: source.slice(last, index), cls: '' });
    const group = TOKEN_CLASSES.findIndex((_, i) => match[i + 1] !== undefined);
    parts.push({ text: match[0], cls: group === -1 ? '' : TOKEN_CLASSES[group] });
    last = index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last), cls: '' });
  return parts;
}

@Component({
  selector: 'app-scenario-editor',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './scenario-editor.html',
  styleUrl: './scenario-editor.css',
})
export class ScenarioEditorComponent implements OnInit {
  scenarioName = '';
  yaml = '';
  parts: YamlPart[] = [];
  saving = false;
  saved = false;
  error = '';
  isNew = false;

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  ngOnInit(): void {
    // Both /scenario/new and /scenario/:name/edit use this component, so re-init on every
    // param change instead of relying on ngOnInit (Angular reuses the instance).
    this.route.paramMap.subscribe((params) => {
      const name = params.get('name') || '';
      this.isNew = !name || name === 'new';
      this.error = '';
      this.saved = false;
      if (this.isNew) {
        this.scenarioName = '';
        this.yaml = this.emptyYaml();
        this.onYamlChange();
      } else {
        this.scenarioName = name;
        void this.loadYaml();
      }
    });
  }

  onYamlChange(): void {
    this.parts = highlightYaml(this.yaml);
  }

  // Keeps the highlighted layer aligned with the textarea when the user scrolls.
  syncScroll(layer: HTMLElement, ta: HTMLTextAreaElement): void {
    layer.scrollTop = ta.scrollTop;
    layer.scrollLeft = ta.scrollLeft;
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
    this.onYamlChange();
    this.cdr.detectChanges();
  }

  // A new scenario goes through the import endpoint, which writes the file and validates it.
  async save(): Promise<void> {
    this.saving = true;
    this.saved = false;
    this.error = '';
    this.cdr.detectChanges();
    try {
      const url = this.isNew ? '/api/scenarios/import' : `/api/scenarios/${encodeURIComponent(this.scenarioName)}/config`;
      const res = await fetch(url, {
        method: this.isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: this.yaml }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.error = this.isNew ? (data.results?.[0]?.error || data.error) : data.error || 'Save failed';
        return;
      }
      if (this.isNew) {
        const created = data.results?.[0];
        if (created?.status !== 'imported') {
          this.error = created?.error || 'Import failed';
          return;
        }
        if (created.replaced) {
          this.error = `"${created.name}" already exists as ${created.file}. Open it to edit it, or rename the scenario.`;
          return;
        }
        await this.router.navigate(['/scenario', created.name, 'edit']);
        return;
      }
      this.saved = true;
      setTimeout(() => { this.saved = false; this.cdr.detectChanges(); }, 3000);
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : 'Save failed';
    } finally {
      this.saving = false;
      this.cdr.detectChanges();
    }
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
