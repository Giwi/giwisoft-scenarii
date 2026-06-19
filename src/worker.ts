import { parentPort, workerData } from 'worker_threads';
import { chromium, Page, BrowserContext, Browser } from 'playwright-core';
import { lightpanda } from '@lightpanda/browser';
import net from 'net';
import { ChildProcess } from 'child_process';
import { Scenario, ScenarioMetrics, StepMetrics, RunOptions } from './types';
import { executeStep } from './actions/index';
import { createScenarioMetrics } from './metrics';
import { getScenarioSettings } from './settings';
import logger from './logger';
import {
  DEFAULT_LIGHTPANDA_PORT, DEFAULT_BROWSER_VIEWPORT, DEFAULT_SCENARIO_TIMEOUT,
  PORT_WAIT_TIMEOUT, SOCKET_TIMEOUT, SOCKET_RETRY_INTERVAL,
  PROCESS_EXIT_TIMEOUT, LIGHTPANDA_START_RETRIES, MIN_PORT, PORT_RANGE,
} from './constants';

type WorkerMessage = Record<string, unknown>;

// Sends a JSON message back to the parent (runner.ts) via the worker message port.
function send(msg: WorkerMessage): void {
  parentPort?.postMessage(msg);
}

// Returns a random port within the configured range to avoid collisions.
function getRandomPort(): number {
  return MIN_PORT + Math.floor(Math.random() * PORT_RANGE);
}

// Polls a TCP port until it is reachable or the timeout expires.
function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${host}:${port}`));
        return;
      }
      const sock = new net.Socket();
      sock.setTimeout(SOCKET_TIMEOUT);
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); setTimeout(tryConnect, SOCKET_RETRY_INTERVAL); });
      sock.once('timeout', () => { sock.destroy(); setTimeout(tryConnect, SOCKET_RETRY_INTERVAL); });
      sock.connect(port, host);
    }
    tryConnect();
  });
}

// Starts a local Lightpanda process on the given port, retrying on EADDRINUSE.
async function startLightpanda(port: number): Promise<{ proc: ChildProcess & { wsEndpoint?: string }; port: number }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < LIGHTPANDA_START_RETRIES; attempt++) {
    const p = attempt === 0 ? port : getRandomPort();
    try {
      const proc = await lightpanda.serve({ host: '127.0.0.1', port: p });
      await waitForPort('127.0.0.1', p, PORT_WAIT_TIMEOUT);
      return { proc, port: p };
    } catch (err: unknown) {
      if (err instanceof Error) {
        const msg = err.message;
        lastErr = err;
        if (msg.includes('EADDRINUSE') || msg.includes('address in use')) {
          continue;
        }
        throw err;
      }
    }
  }
  throw lastErr || new Error('Could not start Lightpanda');
}

// Core scenario execution logic run inside the worker thread.
// Handles browser lifecycle, step execution, timeout, and cleanup.
async function runScenarioInternal(scenario: Scenario, options: RunOptions): Promise<ScenarioMetrics> {
  const metrics = createScenarioMetrics(scenario.name);
  const vars: Record<string, string> = {};
  let browserContext: BrowserContext | null = null;
  let page: Page | null = null;
  let lightpandaProc: (ChildProcess & { wsEndpoint?: string }) | null = null;
  let browser: Browser | null = null;

  const hasBrowserActions = scenario.steps.some((s) => s.action.startsWith('browser.'));
  const scenarioSettings = getScenarioSettings(scenario.name);
  const timeoutMs = options.timeout ?? scenarioSettings.timeout ?? scenario.timeout ?? DEFAULT_SCENARIO_TIMEOUT;
  const ignoreHTTPSErrors = options.ignoreHTTPSErrors ?? scenarioSettings.ignoreHTTPSErrors ?? scenario.ignoreHTTPSErrors ?? false;
  const abortController = new AbortController();

  const run = async () => {
    try {
      if (hasBrowserActions) {
        if (options.lightpandaUrl) {
          try {
            // Reuse the globally running Lightpanda instance (started in server.ts).
            // Each worker creates its own isolated context so runs don't interfere.
            // The shared browser/Lightpanda is NOT closed here — only the context is.
            browser = await chromium.connectOverCDP(options.lightpandaUrl);
          } catch {
            logger.warn({ url: options.lightpandaUrl }, 'Global Lightpanda unavailable, starting per-run instance');
          }
        }
        if (browser) {
          browserContext = await browser.newContext({
            viewport: DEFAULT_BROWSER_VIEWPORT,
            ignoreHTTPSErrors,
          });
          page = await browserContext.newPage();
        } else {
          // Standalone mode: start a fresh Lightpanda instance just for this run.
          const { proc, port } = await startLightpanda(options.lightpandaPort ?? DEFAULT_LIGHTPANDA_PORT);
          lightpandaProc = proc;

          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          browserContext = await browser.newContext({
            viewport: DEFAULT_BROWSER_VIEWPORT,
            ignoreHTTPSErrors,
          });
          page = await browserContext.newPage();
        }
      }

      const stepResults: Map<string, boolean> = new Map();
      for (const step of scenario.steps) {
        if (abortController.signal.aborted) break;
        send({ type: 'step_progress', scenario_name: scenario.name, step_name: step.name, action: step.action, status: 'running' });

        // Evaluate step condition — skip if a prerequisite step didn't meet expectations
        if (step.condition) {
          const prevSuccess = stepResults.get(step.condition.if_step);
          if (step.condition.if_success !== undefined && prevSuccess !== step.condition.if_success) {
            logger.info({ scenario: scenario.name, step: step.name, condition: step.condition }, 'Step condition not met, skipping');
            continue;
          }
        }

        const stepMetrics = await executeStep(step, page, scenario.base_url, vars, step.timeout, abortController.signal);
        metrics.steps.push(stepMetrics);
        stepResults.set(step.name, stepMetrics.success);

        send({
          type: 'step_progress', scenario_name: scenario.name, step_name: step.name,
          action: step.action, status: stepMetrics.success ? 'done' : 'error',
          response_time_ms: stepMetrics.response_time_ms, error: stepMetrics.error,
        });

        if (!stepMetrics.success) {
          metrics.success = false;
        }
      }
      metrics.consecutive_failures = stepResults.size > 0 ? (metrics.success ? 0 : (metrics.consecutive_failures ?? 0) + 1) : 0;
    } catch (err: unknown) {
      metrics.success = false;
      const stepMetrics: StepMetrics = {
        step_name: 'runtime_error', action: 'unknown', success: false,
        response_time_ms: 0, error: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
      };
      metrics.steps.push(stepMetrics);
    } finally {
      if (lightpandaProc) {
        // Per-run Lightpanda (standalone or fallback): close browser and kill process
        if (browser) {
          try { await browser.close(); } catch {}
        } else if (browserContext) {
          try { await browserContext.close(); } catch {}
        }
        try {
          lightpandaProc.stdout?.destroy();
          lightpandaProc.stderr?.destroy();
          lightpandaProc.kill();
          const timer = setTimeout(() => {}, PROCESS_EXIT_TIMEOUT);
          lightpandaProc.once('exit', () => clearTimeout(timer));
          lightpandaProc.once('error', () => clearTimeout(timer));
        } catch {}
      } else if (browserContext) {
        // Global Lightpanda: close only per-run context
        try { await browserContext.close(); } catch {}
      }
    }
  };

  const runPromise = run();
  try {
    await Promise.race([
      runPromise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          abortController.abort();
          reject(new Error(`Scenario "${scenario.name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        runPromise.finally(() => clearTimeout(timer));
      }),
    ]);
  } catch (err: unknown) {
    await runPromise.catch(() => {});
    if (metrics.steps.length === 0 || metrics.steps[metrics.steps.length - 1].step_name !== 'runtime_error') {
      metrics.success = false;
      metrics.steps.push({
        step_name: 'runtime_error', action: 'unknown', success: false,
        response_time_ms: 0, error: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
      });
    }
  }

  metrics.finished_at = new Date();
  metrics.duration_ms = metrics.finished_at.getTime() - metrics.started_at.getTime();
  return metrics;
}

// Worker entry point: receives scenario + options from parent, runs it, and posts the result.
(async () => {
  const { scenario, options } = workerData as { scenario: Scenario; options: RunOptions };
  try {
    const metrics = await runScenarioInternal(scenario, options);
    send({ type: 'completed', metrics });
  } catch (err: unknown) {
    send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
})();
