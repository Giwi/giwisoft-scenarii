import fs from 'fs';
import { Page } from 'playwright-core';
import { BrowserStep, StepMetrics } from '../types';
import { resolveUrl, interpolateVars } from '../helpers';
import { BROWSER_RETRIES, RETRY_DELAYS } from '../retry';
import { DEFAULT_PAGE_TIMEOUT, DEFAULT_SELECTOR_TIMEOUT, SCREENSHOT_COMPARE_THRESHOLD } from '../constants';

async function checkBrowserExpectations(
  page: Page,
  step: BrowserStep,
  vars: Record<string, string>
): Promise<string | null> {
  const expect = step.expect;
  if (!expect) return null;

  if (expect.has_text) {
    const text = await page.textContent('body');
    const expected = interpolateVars(expect.has_text, vars);
    if (!text || !text.includes(expected)) {
      return `Page body does not contain text: "${expected}"`;
    }
  }

  if (expect.not_has_text) {
    const text = await page.textContent('body');
    const expected = interpolateVars(expect.not_has_text, vars);
    if (text && text.includes(expected)) {
      return `Page body contains unexpected text: "${expected}"`;
    }
  }

  if (expect.url_contains) {
    const currentUrl = page.url();
    const expected = interpolateVars(expect.url_contains, vars);
    if (!currentUrl.includes(expected)) {
      return `URL "${currentUrl}" does not contain "${expected}"`;
    }
  }

  if (expect.selector_count !== undefined && step.selector) {
    const count = await page.locator(step.selector).count();
    if (count !== expect.selector_count) {
      return `Selector "${step.selector}" count ${count} != expected ${expect.selector_count}`;
    }
  }

  return null;
}

export async function executeBrowserStep(
  step: BrowserStep,
  page: Page,
  base_url: string | undefined,
  vars: Record<string, string>
): Promise<StepMetrics> {
  const noRetry = step.action === 'browser.evaluate' || step.action === 'browser.screenshot' || step.action === 'browser.screenshot_compare';
  const maxRetries = noRetry ? 0 : BROWSER_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    const stepMetrics: StepMetrics = {
      step_name: step.name,
      action: step.action,
      success: false,
      response_time_ms: 0,
      timestamp: new Date(),
    };

    try {
      switch (step.action) {
        case 'browser.navigate': {
          if (!step.url) throw new Error('browser.navigate requires a "url" field');
          const resolvedUrl = resolveUrl(base_url, interpolateVars(step.url, vars));
          try {
            await page.goto(resolvedUrl, { waitUntil: 'load', timeout: DEFAULT_PAGE_TIMEOUT });
          } catch {
            await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_PAGE_TIMEOUT });
          }
          break;
        }

        case 'browser.fill': {
          if (!step.selector) throw new Error('browser.fill requires a "selector" field');
          if (step.value === undefined) throw new Error('browser.fill requires a "value" field');
          const sel = JSON.stringify(step.selector);
          const val = JSON.stringify(interpolateVars(step.value, vars));
          await page.evaluate(`(() => {
          const el = document.querySelector(${sel});
          if (!el) throw new Error('Element not found: ' + ${sel});
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) { nativeSetter.call(el, ${val}); } else { el.value = ${val}; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
          break;
        }

        case 'browser.type': {
          if (!step.selector) throw new Error('browser.type requires a "selector" field');
          if (step.value === undefined) throw new Error('browser.type requires a "value" field');
          const typedSel = JSON.stringify(step.selector);
          const typedVal = JSON.stringify(interpolateVars(step.value, vars));
          await page.evaluate(`(() => {
          const el = document.querySelector(${typedSel});
          if (!el) throw new Error('Element not found: ' + ${typedSel});
          el.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) { nativeSetter.call(el, ${typedVal}); } else { el.value = ${typedVal}; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
          break;
        }

        case 'browser.click': {
          if (!step.selector) throw new Error('browser.click requires a "selector" field');
          await page.click(step.selector);
          break;
        }

        case 'browser.check': {
          if (!step.selector) throw new Error('browser.check requires a "selector" field');
          await page.check(step.selector);
          break;
        }

        case 'browser.uncheck': {
          if (!step.selector) throw new Error('browser.uncheck requires a "selector" field');
          await page.uncheck(step.selector);
          break;
        }

        case 'browser.select': {
          if (!step.selector) throw new Error('browser.select requires a "selector" field');
          if (step.value === undefined) throw new Error('browser.select requires a "value" field');
          await page.selectOption(step.selector, interpolateVars(step.value, vars));
          break;
        }

        case 'browser.wait_for': {
          if (!step.selector) throw new Error('browser.wait_for requires a "selector" field');
          await page.waitForSelector(step.selector, { timeout: step.timeout || DEFAULT_SELECTOR_TIMEOUT });
          break;
        }

        case 'browser.screenshot': {
          const path = step.value || `screenshot-${Date.now()}.png`;
          await page.screenshot({ path, fullPage: true });
          break;
        }

        case 'browser.screenshot_compare': {
          const basePath = step.value || `baseline-${step.name}.png`;
          const currentPath = `current-${step.name}-${Date.now()}.png`;
          await page.screenshot({ path: currentPath, fullPage: true });
          if (!fs.existsSync(basePath)) {
            fs.renameSync(currentPath, basePath);
            stepMetrics.error = `Baseline created at ${basePath}`;
            throw new Error('Baseline created — no comparison performed');
          }
          const baseBuf = fs.readFileSync(basePath);
          const curBuf = fs.readFileSync(currentPath);
          fs.unlinkSync(currentPath);
          if (baseBuf.length !== curBuf.length) {
            const diff = Math.abs(baseBuf.length - curBuf.length) / Math.max(baseBuf.length, curBuf.length);
            if (diff > SCREENSHOT_COMPARE_THRESHOLD) {
              throw new Error(`Screenshot differs from baseline (size diff ${(diff * 100).toFixed(1)}%)`);
            }
          }
          break;
        }

        case 'browser.evaluate': {
          if (!step.script) throw new Error('browser.evaluate requires a "script" field');
          await page.evaluate(step.script);
          break;
        }
      }

      stepMetrics.response_time_ms = Date.now() - start;

      const error = await checkBrowserExpectations(page, step, vars);
      if (error) {
        stepMetrics.success = false;
        stepMetrics.error = error;
      } else {
        stepMetrics.success = true;
      }
    } catch (err: unknown) {
      stepMetrics.success = false;
      stepMetrics.error = err instanceof Error ? err.message : String(err);
      stepMetrics.response_time_ms = Date.now() - start;
    }

    if (stepMetrics.success || attempt === maxRetries) {
      return stepMetrics;
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
  }

  throw new Error('Retry exhausted');
}
