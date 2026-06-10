import { chromium, Page, BrowserContext, Browser } from 'playwright-core';
import { lightpanda } from '@lightpanda/browser';
import net from 'net';
import { ChildProcess } from 'child_process';
import { Scenario, ScenarioMetrics, StepMetrics } from './types';
import { executeStep } from './actions/index';
import { createScenarioMetrics, consoleReporter, jsonReporter } from './metrics';
import { storeMetrics, purgeOldData, upsertScenarioTags } from './storage';
import { notifyIfStateChanged } from './notifications/index';
import { broadcastScenarioRun, broadcastStepProgress } from './ws';
import { getScenarioSettings, getSettings } from './settings';
import logger from './logger';
import {
  DEFAULT_LIGHTPANDA_PORT, DEFAULT_BROWSER_VIEWPORT, DEFAULT_SCENARIO_TIMEOUT,
  DEFAULT_PURGE_DAYS, PORT_WAIT_TIMEOUT, SOCKET_TIMEOUT, SOCKET_RETRY_INTERVAL,
  PROCESS_EXIT_TIMEOUT, LIGHTPANDA_START_RETRIES, MIN_PORT, PORT_RANGE,
} from './constants';

// Sequential execution queue for browser scenarios — Lightpanda CDP only supports one connection at a time
let browserQueue: Promise<void> = Promise.resolve();

export function sequentialBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const next = browserQueue.then(fn, fn);
  browserQueue = next.then(() => {}, () => {});
  return next;
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    proc.once('error', () => { clearTimeout(timer); resolve(); });
  });
}

export interface RunOptions {
  headless?: boolean;
  json_output?: boolean;
  persist?: boolean;
  lightpandaPort?: number;
  timeout?: number;
  ignoreHTTPSErrors?: boolean;
  signal?: AbortSignal;
}

const runningScenarios = new Map<string, AbortController>();

export function cancelScenario(name: string): boolean {
  const ctrl = runningScenarios.get(name);
  if (ctrl) {
    ctrl.abort();
    runningScenarios.delete(name);
    return true;
  }
  return false;
}

function getRandomPort(): number {
  return MIN_PORT + Math.floor(Math.random() * PORT_RANGE);
}

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

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(`Scenario aborted by user`);
}

async function runScenarioInternal(
  scenario: Scenario,
  options: RunOptions
): Promise<ScenarioMetrics> {
  const metrics = createScenarioMetrics(scenario.name);
  const vars: Record<string, string> = {};
  let browserContext: BrowserContext | null = null;
  let page: Page | null = null;
  let lightpandaProc: (ChildProcess & { wsEndpoint?: string }) | null = null;
  let browser: Browser | null = null;

  const hasBrowserActions = scenario.steps.some((s) => s.action.startsWith('browser.'));
  const scenarioSettings = getScenarioSettings(scenario.name);
  const timeoutMs = options.timeout ?? scenarioSettings.timeout ?? scenario.timeout ?? DEFAULT_SCENARIO_TIMEOUT;

  if (scenario.tags && scenario.tags.length > 0) {
    try {
      upsertScenarioTags(scenario.name, scenario.tags);
    } catch (err: unknown) {
      logger.warn({ scenario: scenario.name, err: err instanceof Error ? err.message : err }, 'Failed to store scenario tags');
    }
  }
  const ignoreHTTPSErrors = options.ignoreHTTPSErrors ?? scenarioSettings.ignoreHTTPSErrors ?? scenario.ignoreHTTPSErrors ?? false;

  const run = async () => {
    try {
      checkAborted(options.signal);
      if (hasBrowserActions) {
        const { proc, port } = await startLightpanda(options.lightpandaPort ?? DEFAULT_LIGHTPANDA_PORT);
        lightpandaProc = proc;

        browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}`);
        browserContext = await browser.newContext({
          viewport: DEFAULT_BROWSER_VIEWPORT,
          ignoreHTTPSErrors,
        });
        page = await browserContext.newPage();
      }

      const stepResults: Map<string, boolean> = new Map();
      for (const step of scenario.steps) {
        checkAborted(options.signal);

        broadcastStepProgress({
          scenario_name: scenario.name,
          step_name: step.name,
          action: step.action,
          status: 'running',
        });

        if (step.condition) {
          const prevSuccess = stepResults.get(step.condition.if_step);
          if (step.condition.if_success !== undefined && prevSuccess !== step.condition.if_success) {
            logger.info({ scenario: scenario.name, step: step.name, condition: step.condition }, 'Step condition not met, skipping');
            continue;
          }
        }

        const stepMetrics = await executeStep(step, page, scenario.base_url, vars, step.timeout, options.signal);
        metrics.steps.push(stepMetrics);
        stepResults.set(step.name, stepMetrics.success);

        broadcastStepProgress({
          scenario_name: scenario.name,
          step_name: step.name,
          action: step.action,
          status: stepMetrics.success ? 'done' : 'error',
          response_time_ms: stepMetrics.response_time_ms,
          error: stepMetrics.error,
        });

        if (!stepMetrics.success) {
          metrics.success = false;
        }
      }
      metrics.consecutive_failures = stepResults.size > 0 ? (metrics.success ? 0 : (metrics.consecutive_failures ?? 0) + 1) : 0;
    } catch (err: unknown) {
      metrics.success = false;
      const stepMetrics: StepMetrics = {
        step_name: 'runtime_error',
        action: 'unknown',
        success: false,
        response_time_ms: 0,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
      };
      metrics.steps.push(stepMetrics);
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (err: unknown) {
          logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to close browser');
        }
      } else if (browserContext) {
        try { await browserContext.close(); } catch (err: unknown) { logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to close browser context'); }
      }
      if (lightpandaProc) {
        try {
          lightpandaProc.stdout?.destroy();
          lightpandaProc.stderr?.destroy();
          lightpandaProc.kill();
          await waitForProcessExit(lightpandaProc, PROCESS_EXIT_TIMEOUT);
        } catch (err: unknown) {
          logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to kill Lightpanda');
        }
      }
    }
  };

  try {
    await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Scenario "${scenario.name}" timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  } catch (err: unknown) {
    if (metrics.steps.length === 0 || metrics.steps[metrics.steps.length - 1].step_name !== 'runtime_error') {
      metrics.success = false;
      const stepMetrics: StepMetrics = {
        step_name: 'runtime_error',
        action: 'unknown',
        success: false,
        response_time_ms: 0,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
      };
      metrics.steps.push(stepMetrics);
    }
  }

  metrics.finished_at = new Date();
  metrics.duration_ms = metrics.finished_at.getTime() - metrics.started_at.getTime();

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

  return metrics;
}

export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {}
): Promise<ScenarioMetrics> {
  const hasBrowserActions = scenario.steps.some((s) => s.action.startsWith('browser.'));

  if (hasBrowserActions) {
    try {
      require.resolve('@lightpanda/browser');
    } catch {
      logger.warn('@lightpanda/browser not installed — browser scenarios will fail with a descriptive error');
    }
  }

  const ctrl = new AbortController();
  if (!options.signal) {
    runningScenarios.set(scenario.name, ctrl);
    options = { ...options, signal: ctrl.signal };
  }

  const execFn = () => runScenarioInternal(scenario, options);

  let result: ScenarioMetrics;
  if (hasBrowserActions) {
    result = await sequentialBrowser(execFn);
  } else {
    result = await execFn();
  }

  runningScenarios.delete(scenario.name);
  return result;
}

export function runHttpScenario(
  scenario: Scenario,
  options: RunOptions = {}
): Promise<ScenarioMetrics> {
  return runScenarioInternal(scenario, options);
}
