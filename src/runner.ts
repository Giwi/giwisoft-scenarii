import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { Scenario, ScenarioMetrics, RunOptions } from './types';
import { createScenarioMetrics, consoleReporter, jsonReporter } from './metrics';
import { storeMetrics, purgeOldData, upsertScenarioTags } from './storage';
import { notifyIfStateChanged } from './notifications/index';
import { broadcastScenarioRun, broadcastStepProgress } from './ws';
import { getScenarioSettings, getSettings } from './settings';
import { resolveIncludes } from './parser';
import logger from './logger';
import { DEFAULT_SCENARIO_TIMEOUT, DEFAULT_PURGE_DAYS } from './constants';

export type { RunOptions };

// Map of currently running scenario names to their worker thread instances
const runningWorkers = new Map<string, Worker>();

// Terminates a running scenario worker by name.
export function cancelScenario(name: string): boolean {
  const worker = runningWorkers.get(name);
  if (worker) {
    worker.terminate();
    return true;
  }
  return false;
}

// Builds a failed metrics object for scenarios that were cancelled or errored before completing.
function createCancelledMetrics(scenarioName: string, error: string): ScenarioMetrics {
  const metrics = createScenarioMetrics(scenarioName);
  metrics.success = false;
  metrics.finished_at = new Date();
  metrics.duration_ms = metrics.finished_at.getTime() - metrics.started_at.getTime();
  metrics.steps.push({
    step_name: 'runtime_error', action: 'unknown', success: false,
    response_time_ms: 0, error,
    timestamp: new Date(),
  });
  return metrics;
}

// Persists metrics to the database, prints the report, sends notifications, and broadcasts over WebSocket.
function persistAndNotify(metrics: ScenarioMetrics, options: RunOptions): void {
  if (options.persist) {
    try {
      storeMetrics(metrics);
      purgeOldData(getSettings().storage?.retentionDays ?? DEFAULT_PURGE_DAYS);
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to store metrics');
    }
  }

  if (options.json_output) {
    jsonReporter(metrics);
  } else {
    consoleReporter(metrics);
  }

  if (options.persist) {
    notifyIfStateChanged(metrics).catch((err) => {
      logger.error({ err }, 'Notification failed');
    });
  }

  broadcastScenarioRun({
    scenario_name: metrics.scenario_name,
    success: metrics.success,
    duration_ms: metrics.duration_ms,
  });
}

// Runs a scenario in a worker thread. Returns a promise that resolves with the final metrics.
// Handles timeout, worker messages (step progress, completion, errors), and unexpected exits.
export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {}
): Promise<ScenarioMetrics> {
  if (scenario.tags?.length) {
    try {
      upsertScenarioTags(scenario.name, scenario.tags);
    } catch (err: unknown) {
      logger.warn({ scenario: scenario.name, err: err instanceof Error ? err.message : err }, 'Failed to store scenario tags');
    }
  }

  const scenarioSettings = getScenarioSettings(scenario.name);
  const timeoutMs = options.timeout ?? scenarioSettings.timeout ?? scenario.timeout ?? DEFAULT_SCENARIO_TIMEOUT;

  if (options.scenariosDir) {
    try {
      scenario.steps = resolveIncludes(scenario, options.scenariosDir);
    } catch (err: unknown) {
      const metrics = createCancelledMetrics(scenario.name, `Include resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      persistAndNotify(metrics, options);
      return Promise.resolve(metrics);
    }
  }

  return new Promise<ScenarioMetrics>((resolve) => {
    let resolved = false;

    const workerPath = path.join(__dirname, 'worker.js');
    const worker = new Worker(
      fs.existsSync(workerPath) ? workerPath : path.join(__dirname, 'worker.ts'),
      {
        workerData: { scenario, options },
        execArgv: fs.existsSync(workerPath) ? [] : ['-r', 'ts-node/register'],
      },
    );

    runningWorkers.set(scenario.name, worker);

    // Safety timeout: kills the worker if it doesn't finish within reasonable bounds
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        runningWorkers.delete(scenario.name);
        worker.terminate();
        const metrics = createCancelledMetrics(scenario.name, `Scenario "${scenario.name}" timed out after ${timeoutMs}ms`);
        persistAndNotify(metrics, options);
        resolve(metrics);
      }
    }, timeoutMs + 60000).unref();

    worker.on('message', (msg: Record<string, unknown>) => {
      if (msg.type === 'step_progress') {
        broadcastStepProgress({
          scenario_name: msg.scenario_name as string,
          step_name: msg.step_name as string,
          action: msg.action as string,
          status: msg.status as 'running' | 'done' | 'error',
          response_time_ms: msg.response_time_ms as number | undefined,
          error: msg.error as string | undefined,
        });
      } else if (msg.type === 'completed') {
        if (!resolved) {
          resolved = true;
          clearTimeout(safetyTimer);
          runningWorkers.delete(scenario.name);
          const metrics = msg.metrics as ScenarioMetrics;
          persistAndNotify(metrics, options);
          resolve(metrics);
        }
      } else if (msg.type === 'error') {
        if (!resolved) {
          resolved = true;
          clearTimeout(safetyTimer);
          runningWorkers.delete(scenario.name);
          logger.error({ scenario: scenario.name, error: msg.error }, 'Worker reported error');
          const metrics = createCancelledMetrics(scenario.name, String(msg.error));
          persistAndNotify(metrics, options);
          resolve(metrics);
        }
      }
    });

    worker.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(safetyTimer);
        runningWorkers.delete(scenario.name);
        logger.error({ scenario: scenario.name, err }, 'Worker error');
        const metrics = createCancelledMetrics(scenario.name, err instanceof Error ? err.message : String(err));
        persistAndNotify(metrics, options);
        resolve(metrics);
      }
    });

    worker.on('exit', (code) => {
      clearTimeout(safetyTimer);
      if (!resolved) {
        resolved = true;
        runningWorkers.delete(scenario.name);
        logger.warn({ scenario: scenario.name, exitCode: code }, 'Worker exited unexpectedly');
        const metrics = createCancelledMetrics(scenario.name, `Worker exited with code ${code}`);
        persistAndNotify(metrics, options);
        resolve(metrics);
      }
    });
  });
}
