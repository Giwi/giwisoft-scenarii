import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStepMetrics, completeStepMetrics, createScenarioMetrics } from '../src/metrics';

describe('createStepMetrics', () => {
  it('creates a default failing step', () => {
    const m = createStepMetrics('step1', 'http.get');
    assert.strictEqual(m.step_name, 'step1');
    assert.strictEqual(m.action, 'http.get');
    assert.strictEqual(m.success, false);
    assert.strictEqual(m.response_time_ms, 0);
    assert.ok(m.timestamp instanceof Date);
  });
});

describe('completeStepMetrics', () => {
  it('merges overrides and updates timestamp', () => {
    const base = createStepMetrics('s1', 'http.get');
    const done = completeStepMetrics(base, { success: true, response_time_ms: 150 });
    assert.strictEqual(done.success, true);
    assert.strictEqual(done.response_time_ms, 150);
    assert.strictEqual(done.step_name, 's1');
    assert.ok(done.timestamp instanceof Date);
  });

  it('does not mutate the original', () => {
    const base = createStepMetrics('s1', 'http.get');
    const done = completeStepMetrics(base, { success: true });
    assert.strictEqual(base.success, false);
    assert.strictEqual(done.success, true);
  });
});

describe('createScenarioMetrics', () => {
  it('creates a default successful scenario', () => {
    const m = createScenarioMetrics('my-scenario');
    assert.strictEqual(m.scenario_name, 'my-scenario');
    assert.strictEqual(m.success, true);
    assert.strictEqual(m.duration_ms, 0);
    assert.deepStrictEqual(m.steps, []);
    assert.ok(m.started_at instanceof Date);
    assert.ok(m.finished_at instanceof Date);
  });
});
