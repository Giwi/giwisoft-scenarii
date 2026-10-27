import { ScenarioMetrics } from '../../types';
import { HistoryRow } from './types';

// Formats a timestamp as a lexicographically sortable UTC string (no timezone suffix),
// matching the TEXT timestamp columns used by both backends.
export function sqlNow(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// Returns the UTC timestamp `days` days ago in the same sortable format.
export function daysAgo(days: number): string {
  return sqlNow(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

// Collapses a flat run+step join result into ScenarioMetrics objects, preserving run
// order (rows are ordered by created_at DESC, then step id).
export function collapseHistory(rows: HistoryRow[]): ScenarioMetrics[] {
  const runMap = new Map<number, ScenarioMetrics>();
  for (const row of rows) {
    if (!runMap.has(row.run_id)) {
      runMap.set(row.run_id, {
        scenario_name: row.scenario_name,
        started_at: new Date(row.started_at),
        finished_at: new Date(row.finished_at),
        duration_ms: row.duration_ms,
        success: row.success === 1,
        flaky: row.flaky === 1,
        steps: [],
      });
    }
    if (row.step_id !== null) {
      const run = runMap.get(row.run_id)!;
      run.steps.push({
        step_name: row.step_name!,
        action: row.action!,
        success: row.step_success === 1,
        status_code: row.status_code ?? undefined,
        response_time_ms: row.response_time_ms!,
        attempts: row.attempts ?? undefined,
        error: row.error ?? undefined,
        timestamp: new Date(row.timestamp!),
        request_url: row.request_url ?? undefined,
        request_method: row.request_method ?? undefined,
        request_headers: row.request_headers ? (JSON.parse(row.request_headers as string) as Record<string, string>) : undefined,
        request_body: row.request_body ?? undefined,
        response_headers: row.response_headers ? (JSON.parse(row.response_headers as string) as Record<string, string>) : undefined,
        response_body: row.response_body ?? undefined,
      });
    }
  }
  return Array.from(runMap.values());
}

// Parses a JSON-encoded tags column, returning undefined when absent or malformed.
export function parseTags(tags: string | null | undefined): string[] | undefined {
  if (!tags) return undefined;
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return undefined;
  }
}
