// Utility functions shared across the server: URL resolution, variable interpolation,
// JSON path resolution, and various output-formatting helpers (CSV, Prometheus, HTML).

import { ScenarioMetrics } from './types';
import { DEFAULT_HISTORY_DAYS, MIN_DAYS, MAX_DAYS } from './constants';

// Resolves a URL against an optional base URL. Absolute URLs pass through unchanged.
export function resolveUrl(base_url: string | undefined, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!base_url) throw new Error('No base_url configured and url is relative');
  return `${base_url.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

// Replaces {{variable}} placeholders in a template string with values from the vars map.
export function interpolateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// Navigates a parsed JSON object using a dot-notation path (e.g. $.data.items[0].id).
// Returns the value at that path, or undefined if any segment is missing.
export function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace('$.', '').split('.');
  let value: unknown = obj;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      value = (value as Record<string, unknown>)[arrMatch[1]];
      if (Array.isArray(value)) value = value[parseInt(arrMatch[2])];
      else return undefined;
    } else {
      value = (value as Record<string, unknown>)[part];
    }
  }
  return value;
}

// Escapes a string for use in Prometheus label values.
export function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Escapes a string for CSV output (wraps in quotes if needed).
export function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// Converts an array of ScenarioMetrics into CSV format with step-level detail.
export function toCsv(history: ScenarioMetrics[]): string {
  const header = 'started_at,finished_at,duration_ms,success,step_name,step_action,step_success,step_response_time_ms,step_error\n';
  const rows = history.flatMap(r =>
    r.steps.map(s =>
      `${r.started_at.toISOString()},${r.finished_at.toISOString()},${r.duration_ms},${r.success},${escapeCsv(s.step_name)},${escapeCsv(s.action)},${s.success},${s.response_time_ms},${escapeCsv(s.error || '')}`
    )
  );
  return header + rows.join('\n');
}

// Escapes HTML special characters for safe embedding in HTML output.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Parses the "days" query parameter within valid bounds.
export function parseDaysParam(value: string | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_DAYS;
  const n = parseInt(value);
  if (isNaN(n) || n < MIN_DAYS || n > MAX_DAYS) return DEFAULT_HISTORY_DAYS;
  return n;
}

// Parses the "limit" query parameter into a number or undefined.
export function parseLimitParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value);
  return isNaN(n) ? undefined : n;
}
