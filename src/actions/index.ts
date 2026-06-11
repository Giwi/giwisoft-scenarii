import { Page } from 'playwright-core';
import { Step, StepMetrics } from '../types';
import { executeHttpStep } from './http';
import { executeBrowserStep } from './browser';

export async function executeStep(
  step: Step,
  page: Page | null,
  base_url: string | undefined,
  vars: Record<string, string>,
  stepTimeout?: number,
  signal?: AbortSignal,
): Promise<StepMetrics> {
  const runner = async (): Promise<StepMetrics> => {
    if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
    if (step.action.startsWith('http.')) {
      return executeHttpStep(step as import('../types').HttpStep, base_url, vars, signal);
    }
    if (step.action.startsWith('browser.')) {
      if (!page) throw new Error('Browser not initialized for browser action');
      return executeBrowserStep(step as import('../types').BrowserStep, page, base_url, vars, signal);
    }
    throw new Error(`Unknown action: ${step.action}`);
  };

  const timeout = stepTimeout ?? step.timeout;
  const cancellableRunner = async (): Promise<StepMetrics> => {
    const runnerPromise = runner().catch(() => undefined as unknown as StepMetrics);
    return new Promise<StepMetrics>((resolve, reject) => {
      runnerPromise.then(resolve, reject);
      if (signal) {
        signal.addEventListener('abort', () => reject(new Error(`Step "${step.name}" aborted by user`)), { once: true });
      }
    });
  };

  if (!timeout) return cancellableRunner();

  return Promise.race([
    cancellableRunner(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Step "${step.name}" timed out after ${timeout}ms`)), timeout)
    ),
  ]);
}
