import { chromium, Page, BrowserContext, Browser } from 'playwright-core';
import { lightpanda } from '@lightpanda/browser';
import net from 'net';
import { ChildProcess } from 'child_process';
import { Scenario, ScenarioMetrics, StepMetrics } from './types';
import { executeStep } from './actions/index';
import { createScenarioMetrics, consoleReporter, jsonReporter } from './metrics';
import { storeMetrics, purgeOldData, upsertScenarioTags } from './storage';
import { notifyIfStateChanged } from './notifications/index';
import { broadcastScenarioRun } from './ws';
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

      for (const step of scenario.steps) {
        const stepMetrics = await executeStep(step, page, scenario.base_url, vars);
        metrics.steps.push(stepMetrics);

        if (!stepMetrics.success) {
          metrics.success = false;
        }
      }
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

  const execFn = () => runScenarioInternal(scenario, options);

  if (hasBrowserActions) {
    return sequentialBrowser(execFn);
  }
  return execFn();
}

export function runHttpScenario(
  scenario: Scenario,
  options: RunOptions = {}
): Promise<ScenarioMetrics> {
  return runScenarioInternal(scenario, options);
}
