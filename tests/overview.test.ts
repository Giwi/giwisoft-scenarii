import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { initStorage, closeStorage, storeMetrics, getOverview } from '../src/config/storage';
import { buildOverview } from '../src/config/storage/shared';
import { ScenarioMetrics } from '../src/types';

function makeMetrics(name: string, duration: number, success: boolean, flaky: boolean): ScenarioMetrics {
  const started = new Date();
  return {
    scenario_name: name,
    started_at: started,
    finished_at: new Date(started.getTime() + duration),
    duration_ms: duration,
    success,
    flaky,
    steps: [],
  };
}

before(async () => {
  await initStorage(':memory:');
});

after(async () => {
  await closeStorage();
});

describe('overview aggregates', () => {
  it('computes p95 and ranks slowest scenarios', () => {
    const rows = {
      daily: [],
      runs: Array.from({ length: 10 }, (_, i) => ({
        scenario_name: 'slow',
        duration_ms: (i + 1) * 100,
        success: 1,
        flaky: 0,
      })).concat(Array.from({ length: 10 }, () => ({
        scenario_name: 'fast',
        duration_ms: 50,
        success: 1,
        flaky: 0,
      }))),
    };
    const overview = buildOverview(7, rows);
    assert.strictEqual(overview.slowest[0].name, 'slow');
    assert.strictEqual(overview.slowest[0].p95_ms, 1000);
    assert.strictEqual(overview.slowest[1].p95_ms, 50);
  });

  it('ranks flaky scenarios by ratio', () => {
    const rows = {
      daily: [],
      runs: [
        { scenario_name: 'often-flaky', duration_ms: 10, success: 1, flaky: 1 },
        { scenario_name: 'often-flaky', duration_ms: 10, success: 1, flaky: 1 },
        { scenario_name: 'often-flaky', duration_ms: 10, success: 1, flaky: 0 },
        { scenario_name: 'often-flaky', duration_ms: 10, success: 1, flaky: 0 },
        { scenario_name: 'rarely-flaky', duration_ms: 10, success: 1, flaky: 1 },
        { scenario_name: 'rarely-flaky', duration_ms: 10, success: 1, flaky: 0 },
        { scenario_name: 'rarely-flaky', duration_ms: 10, success: 1, flaky: 0 },
        { scenario_name: 'rarely-flaky', duration_ms: 10, success: 1, flaky: 0 },
      ],
    };
    const overview = buildOverview(7, rows);
    assert.strictEqual(overview.flakiest[0].name, 'often-flaky');
    assert.strictEqual(overview.flakiest[0].flaky_runs, 2);
  });

  it('fills the calendar with every day in the window', async () => {
    await storeMetrics(makeMetrics('alpha', 120, true, false));
    await storeMetrics(makeMetrics('alpha', 300, false, true));
    await storeMetrics(makeMetrics('beta', 80, true, false));

    const overview = await getOverview(30);
    assert.strictEqual(overview.daily.length, 30);
    assert.strictEqual(overview.totals.runs, 3);
    assert.strictEqual(overview.totals.passed, 2);
    assert.strictEqual(overview.totals.failed, 1);
    assert.strictEqual(overview.totals.flaky, 1);

    const today = overview.daily[overview.daily.length - 1];
    assert.strictEqual(today.total, 3);
    assert.strictEqual(today.passed, 2);
    assert.ok(overview.slowest.some(s => s.name === 'alpha'));
    assert.strictEqual(overview.flakiest[0].name, 'alpha');
  });
});
