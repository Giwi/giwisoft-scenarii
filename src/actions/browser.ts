import { Page } from 'playwright-core';
import { BrowserStep, StepMetrics } from '../types';

function resolveUrl(base_url: string | undefined, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!base_url) throw new Error('No base_url configured and url is relative');
  return `${base_url.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function interpolateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

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
        await page.goto(resolvedUrl, { waitUntil: 'load' });
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
        await page.waitForSelector(step.selector, { timeout: step.timeout || 10000 });
        break;
      }

      case 'browser.screenshot': {
        const path = step.value || `screenshot-${Date.now()}.png`;
        await page.screenshot({ path, fullPage: true });
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

  return stepMetrics;
}
