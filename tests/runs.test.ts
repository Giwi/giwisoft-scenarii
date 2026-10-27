import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { initStorage, closeStorage, createRun, completeRun, storeMetrics, getRun, getScenarioHistory } from '../src/config/storage';
import { ScenarioMetrics } from '../src/types';

const started = new Date('2026-01-01T10:00:00.000Z');

function metrics(overrides: Partial<ScenarioMetrics> = {}): ScenarioMetrics {
  return {
    scenario_name: 'run-test',
    started_at: started,
    finished_at: new Date('2026-01-01T10:00:02.000Z'),
    duration_ms: 2000,
    success: true,
    steps: [
      {
        step_name: 'Homepage',
        action: 'http.get',
        success: true,
        status_code: 200,
        response_time_ms: 120,
        timestamp: started,
      },
    ],
    ...overrides,
  };
}

before(async () => {
  await initStorage(':memory:');
});

after(async () => {
  await closeStorage();
});

describe('run persistence', () => {
  it('creates a run before execution and completes it with steps', async () => {
    const id = await createRun('run-test', started);
    assert.strictEqual(id, 1);

    await completeRun(id, metrics());

    const run = await getRun(id);
    assert.ok(run);
    assert.strictEqual(run!.run_id, id);
    assert.strictEqual(run!.scenario_name, 'run-test');
    assert.strictEqual(run!.success, true);
    assert.strictEqual(run!.duration_ms, 2000);
    assert.strictEqual(run!.steps.length, 1);
    assert.strictEqual(run!.steps[0].step_name, 'Homepage');
  });

  it('storeMetrics returns the persisted id', async () => {
    const id = await storeMetrics(metrics({ success: false }));
    assert.strictEqual(typeof id, 'number');
    const run = await getRun(id);
    assert.strictEqual(run!.success, false);
  });

  it('includes run_id in scenario history', async () => {
    const history = await getScenarioHistory('run-test', 30, 10, 0);
    assert.ok(history.length >= 2);
    assert.ok(history.every(r => typeof r.run_id === 'number'));
  });

  it('returns undefined for an unknown run', async () => {
    assert.strictEqual(await getRun(9999), undefined);
  });
});
