import { Page } from 'playwright-core';
import { Step, StepMetrics } from '../types';
import { executeHttpStep } from './http';
import { executeBrowserStep } from './browser';

export async function executeStep(
  step: Step,
  page: Page | null,
  base_url: string | undefined,
  vars: Record<string, string>
): Promise<StepMetrics> {
  if (step.action.startsWith('http.')) {
    return executeHttpStep(step as import('../types').HttpStep, base_url, vars);
  }
  if (step.action.startsWith('browser.')) {
    if (!page) throw new Error('Browser not initialized for browser action');
    return executeBrowserStep(step as import('../types').BrowserStep, page, base_url, vars);
  }
  throw new Error(`Unknown action: ${step.action}`);
}
