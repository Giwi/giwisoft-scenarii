import { describe, it } from 'node:test';
import assert from 'node:assert';
import { diffRuns } from '../src/utils/run-diff';
import { ScenarioMetrics } from '../src/types';

function metrics(steps: ScenarioMetrics['steps'], overrides: Partial<ScenarioMetrics> = {}): ScenarioMetrics {
  const started = new Date('2026-01-01T10:00:00.000Z');
  return {
    run_id: 1,
    scenario_name: 'demo',
    started_at: started,
    finished_at: new Date(started.getTime() + 1000),
    duration_ms: 1000,
    success: true,
    steps,
    ...overrides,
  };
}

const base = metrics([
  { step_name: 'A', action: 'http.get', success: true, response_time_ms: 100, status_code: 200, timestamp: new Date() },
  { step_name: 'B', action: 'http.get', success: false, response_time_ms: 200, status_code: 500, error: 'old error', timestamp: new Date() },
]);

const target = metrics([
  { step_name: 'A', action: 'http.get', success: false, response_time_ms: 150, status_code: 500, error: 'new error', timestamp: new Date() },
  { step_name: 'B', action: 'http.get', success: true, response_time_ms: 100, status_code: 200, timestamp: new Date() },
  { step_name: 'C', action: 'http.get', success: true, response_time_ms: 50, status_code: 200, timestamp: new Date() },
], { run_id: 2, duration_ms: 1500, success: false });

describe('diffRuns', () => {
  it('reports run-level status and duration changes', () => {
    const diff = diffRuns(base, target);
    assert.strictEqual(diff.status_changed, true);
    assert.strictEqual(diff.duration_delta_ms, 500);
    assert.strictEqual(diff.duration_delta_pct, 50);
  });

  it('reports per-step status, duration and error changes', () => {
    const diff = diffRuns(base, target);
    const a = diff.steps.find(s => s.step_name === 'A')!;
    assert.strictEqual(a.status_changed, true);
    assert.strictEqual(a.duration_delta_ms, 50);
    assert.strictEqual(a.duration_delta_pct, 50);
    assert.strictEqual(a.error_changed, true);
    assert.strictEqual(a.base?.error, undefined);
    assert.strictEqual(a.target?.error, 'new error');

    const b = diff.steps.find(s => s.step_name === 'B')!;
    assert.strictEqual(b.status_changed, true);
    assert.strictEqual(b.duration_delta_ms, -100);
    assert.strictEqual(b.error_changed, true);
  });

  it('includes added and removed steps with one missing side', () => {
    const removed = diffRuns(base, metrics([{ step_name: 'A', action: 'http.get', success: true, response_time_ms: 100, timestamp: new Date() }]));
    const b = removed.steps.find(s => s.step_name === 'B')!;
    assert.ok(b.base);
    assert.strictEqual(b.target, undefined);

    const added = diffRuns(base, target);
    const c = added.steps.find(s => s.step_name === 'C')!;
    assert.strictEqual(c.base, undefined);
    assert.ok(c.target);
  });

  it('keeps unchanged steps neutral', () => {
    const diff = diffRuns(base, base);
    assert.strictEqual(diff.status_changed, false);
    assert.strictEqual(diff.duration_delta_ms, 0);
    assert.ok(diff.steps.every(s => !s.status_changed && !s.error_changed && s.duration_delta_ms === 0));
  });
});
