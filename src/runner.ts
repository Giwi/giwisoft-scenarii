import { chromium, request as playwrightRequest, Page, BrowserContext, Browser, APIRequestContext } from 'playwright-core';
import { lightpanda } from '@lightpanda/browser';
import net from 'net';
import { ChildProcess } from 'child_process';
import { Scenario, ScenarioMetrics, StepMetrics } from './types';
import { executeStep } from './actions/index';
import { createScenarioMetrics, consoleReporter, jsonReporter } from './metrics';
import { storeMetrics, purgeOldData } from './storage';
import { notifyIfStateChanged } from './notifications/index';
import { broadcastScenarioRun } from './ws';

// Sequential execution queue — Lightpanda CDP only supports one connection at a time
let executionQueue: Promise<void> = Promise.resolve();

function sequential<T>(fn: () => Promise<T>): Promise<T> {
  const next = executionQueue.then(fn, fn);
  executionQueue = next.then(() => {}, () => {});
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
}

function getRandomPort(): number {
  return 9000 + Math.floor(Math.random() * 1000);
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
      sock.setTimeout(1000);
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); setTimeout(tryConnect, 200); });
      sock.once('timeout', () => { sock.destroy(); setTimeout(tryConnect, 200); });
      sock.connect(port, host);
    }
    tryConnect();
  });
}

async function startLightpanda(port: number): Promise<{ proc: ChildProcess & { wsEndpoint?: string }; port: number }> {
  const lastErr: Error = new Error('Could not start Lightpanda');
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = attempt === 0 ? port : getRandomPort();
    try {
      const proc = await lightpanda.serve({ host: '127.0.0.1', port: p });
      await waitForPort('127.0.0.1', p, 5000);
      return { proc, port: p };
    } catch (err: unknown) {
      if (err instanceof Error) {
        const msg = err.message;
        if (msg.includes('EADDRINUSE') || msg.includes('address in use')) {
          continue;
        }
        throw err;
      }
    }
  }
  throw lastErr;
}

export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {}
): Promise<ScenarioMetrics> {
  return sequential(async () => {
    const metrics = createScenarioMetrics(scenario.name);
    const vars: Record<string, string> = {};
    let browserContext: BrowserContext | null = null;
    let page: Page | null = null;
    let apiContext: APIRequestContext | null = null;
    let lightpandaProc: (ChildProcess & { wsEndpoint?: string }) | null = null;
    let browser: Browser | null = null;

    const hasBrowserActions = scenario.steps.some((s) => s.action.startsWith('browser.'));
    const timeoutMs = options.timeout ?? 120_000;

    const run = async () => {
      try {
        if (hasBrowserActions) {
          const { proc, port } = await startLightpanda(options.lightpandaPort ?? 9222);
          lightpandaProc = proc;

          browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}`);
          browserContext = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true,
          });
          page = await browserContext.newPage();
          apiContext = await playwrightRequest.newContext({
            ignoreHTTPSErrors: true,
          });
        } else {
          apiContext = await playwrightRequest.newContext({
            ignoreHTTPSErrors: true,
          });
        }

        for (const step of scenario.steps) {
          const stepMetrics = await executeStep(step, page, apiContext!, scenario.base_url, vars);
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
            const contexts = browser.contexts();
            for (const ctx of contexts) {
              try { await ctx.close(); } catch { /* ignore */ }
            }
            await browser.close();
          } catch { /* ignore close errors */ }
        } else if (browserContext) {
          try { await browserContext.close(); } catch { /* ignore */ }
        }
        if (lightpandaProc) {
          try {
            lightpandaProc.stdout?.destroy();
            lightpandaProc.stderr?.destroy();
            lightpandaProc.kill();
            await waitForProcessExit(lightpandaProc, 3000);
          } catch { /* ignore kill errors */ }
        }
        if (apiContext) {
          try { await apiContext.dispose(); } catch {}
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
      // Ensure a runtime_error step is recorded on timeout
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
      purgeOldData(7);
    } catch (err) {
      console.error('Failed to store metrics:', err);
    }
  }

  if (options.json_output) {
    jsonReporter(metrics);
  } else {
    consoleReporter(metrics);
  }

  if (options.persist) {
    notifyIfStateChanged(metrics).catch(() => {});
  }

  broadcastScenarioRun({
    scenario_name: metrics.scenario_name,
    success: metrics.success,
    duration_ms: metrics.duration_ms,
  });

  return metrics;
  });
}
