import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

// ── Mock worker_threads before runner imports it ──────────────────────────
const capturedWorkers: Array<{
  worker: EventEmitter;
  workerData: unknown;
  filename: string;
}> = [];

mock.module('worker_threads', {
  namedExports: {
    Worker: class MockWorker extends EventEmitter {
      public filename: string;
      public workerData: unknown;

      constructor(filename: string, options: { workerData: unknown }) {
        super();
        this.filename = filename;
        this.workerData = options.workerData;
        capturedWorkers.push({ worker: this, workerData: options.workerData, filename });
      }

      terminate(): void {
        process.nextTick(() => this.emit('exit', 0));
      }

      postMessage(): void {}
    },
    isMainThread: true,
    workerData: null,
    parentPort: null,
  },
});

// ── Imports (after mock) ─────────────────────────────────────────────────
import { runScenario, cancelScenario } from '../src/runner';
import type { Scenario, ScenarioMetrics, RunOptions } from '../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────
function makeScenario(name = 'test'): Scenario {
  return {
    name,
    steps: [{ action: 'http.get', name: 'step1', url: '/test' }],
  };
}

function emitCompleted(worker: EventEmitter, overrides: Partial<ScenarioMetrics> = {}): void {
  worker.emit('message', {
    type: 'completed',
    metrics: {
      scenario_name: 'test',
      started_at: new Date(),
      finished_at: new Date(),
      duration_ms: 42,
      success: true,
      steps: [{ step_name: 's1', action: 'http.get', success: true, response_time_ms: 10, timestamp: new Date() }],
      ...overrides,
    },
  });
}

describe('cancelScenario', () => {
  it('returns false when nothing is running', () => {
    assert.strictEqual(cancelScenario('nonexistent'), false);
  });

  it('terminates a running worker and returns true', async () => {
    capturedWorkers.length = 0;
    const p = runScenario(makeScenario('cancel-me'));
    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'cancel-me');
    assert.ok(entry, 'worker should have been spawned');

    const result = cancelScenario('cancel-me');
    assert.strictEqual(result, true);

    const metrics = await p;
    assert.strictEqual(metrics.success, false);
    assert.strictEqual(metrics.scenario_name, 'cancel-me');
    // Should have a runtime_error step
    const errStep = metrics.steps.find(s => s.step_name === 'runtime_error');
    assert.ok(errStep);
    assert.ok(errStep!.error);
  });

  it('returns false after scenario completes', async () => {
    capturedWorkers.length = 0;
    const s = makeScenario('complete-first');
    const p = runScenario(s, {});
    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'complete-first');
    assert.ok(entry);

    emitCompleted(entry.worker);
    await p;

    assert.strictEqual(cancelScenario('complete-first'), false);
  });
});

describe('runScenario', () => {
  before(() => { capturedWorkers.length = 0; });

  it('spawns a worker with scenario and options', async () => {
    const s = makeScenario('spawn-test');
    const p = runScenario(s, { persist: false });

    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'spawn-test');
    assert.ok(entry);
    assert.match(entry.filename, /worker\.js$/);
    assert.deepStrictEqual((entry.workerData as any).scenario, s);
    assert.deepStrictEqual((entry.workerData as any).options, { persist: false });

    emitCompleted(entry.worker);
    await p;
  });

  it('resolves with metrics on completed message', async () => {
    capturedWorkers.length = 0;
    const p = runScenario(makeScenario('completed-test'));
    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'completed-test');
    assert.ok(entry);

    emitCompleted(entry.worker, { success: true, duration_ms: 100 });
    const metrics = await p;

    assert.strictEqual(metrics.success, true);
    assert.strictEqual(metrics.duration_ms, 100);
  });

  it('resolves with failed metrics on error message', async () => {
    capturedWorkers.length = 0;
    const p = runScenario(makeScenario('error-test'));
    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'error-test');
    assert.ok(entry);

    entry.worker.emit('message', { type: 'error', error: 'Something went wrong' });
    const metrics = await p;

    assert.strictEqual(metrics.success, false);
    const errStep = metrics.steps.find(s => s.step_name === 'runtime_error');
    assert.ok(errStep);
    assert.match(errStep!.error || '', /Something went wrong/);
  });

  it('resolves with failed metrics on worker exit without completion', async () => {
    capturedWorkers.length = 0;
    const p = runScenario(makeScenario('exit-test'));
    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'exit-test');
    assert.ok(entry);

    entry.worker.emit('exit', 1);
    const metrics = await p;

    assert.strictEqual(metrics.success, false);
    const errStep = metrics.steps.find(s => s.step_name === 'runtime_error');
    assert.ok(errStep);
    assert.match(errStep!.error || '', /code 1/);
  });

  it('ignores duplicate completion', async () => {
    capturedWorkers.length = 0;
    let resolveCount = 0;
    const p = runScenario(makeScenario('dup-test'));
    p.then(() => resolveCount++);

    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'dup-test');
    assert.ok(entry);

    emitCompleted(entry.worker, { duration_ms: 50 });
    emitCompleted(entry.worker, { duration_ms: 99 });

    await p;
    assert.strictEqual(resolveCount, 1);
  });

  it('handles step_progress messages without crashing', async () => {
    capturedWorkers.length = 0;
    const p = runScenario(makeScenario('progress-test'));
    const entry = capturedWorkers.find(w => (w.workerData as any)?.scenario?.name === 'progress-test');
    assert.ok(entry);

    entry.worker.emit('message', {
      type: 'step_progress', scenario_name: 'progress-test',
      step_name: 's1', action: 'http.get', status: 'running',
    });
    entry.worker.emit('message', {
      type: 'step_progress', scenario_name: 'progress-test',
      step_name: 's1', action: 'http.get', status: 'done',
      response_time_ms: 10,
    });

    emitCompleted(entry.worker);
    await p;
  });
});

// ── Worker module tests ──────────────────────────────────────────────────
describe('worker module', () => {
  it('exports a Worker script that can be required', () => {
    const workerPath = require.resolve('../src/worker');
    assert.ok(workerPath);
    assert.match(workerPath, /worker\.(ts|js)$/);
  });
});
