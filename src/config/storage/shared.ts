import { ScenarioMetrics } from '../../types';
import { DailyPassRate, HistoryRow, OverviewData, OverviewRowSet, ScenarioStat } from './types';

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
        run_id: row.run_id,
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

// Nearest-rank percentile over an ascending-sorted array.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

// Builds the cross-scenario overview from daily counts and per-run rows.
// Slowest is ranked by p95 duration; flakiest by flaky-run ratio.
export function buildOverview(days: number, rowSet: OverviewRowSet): OverviewData {
  const byScenario = new Map<string, { durations: number[]; passed: number; failed: number; flaky: number }>();
  let passed = 0;
  let failed = 0;
  let flaky = 0;

  for (const row of rowSet.runs) {
    let entry = byScenario.get(row.scenario_name);
    if (!entry) {
      entry = { durations: [], passed: 0, failed: 0, flaky: 0 };
      byScenario.set(row.scenario_name, entry);
    }
    entry.durations.push(row.duration_ms);
    if (row.success === 1) {
      entry.passed++;
      passed++;
    } else {
      entry.failed++;
      failed++;
    }
    if (row.flaky === 1) {
      entry.flaky++;
      flaky++;
    }
  }

  const stats: ScenarioStat[] = [...byScenario.entries()].map(([name, entry]) => {
    const durations = [...entry.durations].sort((a, b) => a - b);
    const total = entry.passed + entry.failed;
    return {
      name,
      total_runs: total,
      passed_runs: entry.passed,
      failed_runs: entry.failed,
      flaky_runs: entry.flaky,
      avg_ms: total > 0 ? Math.round(entry.durations.reduce((sum, d) => sum + d, 0) / total) : 0,
      p95_ms: percentile(durations, 0.95),
    };
  });

  const slowest = [...stats].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 10);
  const flakiest = stats
    .filter(s => s.flaky_runs > 0)
    .sort((a, b) => {
      const ratio = b.flaky_runs / Math.max(1, b.total_runs) - a.flaky_runs / Math.max(1, a.total_runs);
      if (ratio !== 0) return ratio;
      return b.flaky_runs - a.flaky_runs;
    })
    .slice(0, 10);

  const dailyMap = new Map(rowSet.daily.map(d => [d.date, d]));
  const daily: DailyPassRate[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = date.toISOString().slice(0, 10);
    const entry = dailyMap.get(key);
    daily.push({ date: key, total: entry?.total ?? 0, passed: entry?.passed ?? 0 });
  }

  return {
    days,
    totals: { runs: passed + failed, passed, failed, flaky },
    daily,
    slowest,
    flakiest,
  };
}
