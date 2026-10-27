import fs from 'fs';
import path from 'path';
import { Page } from 'playwright-core';
import { BrowserStep, StepMetrics } from '../types';
import { resolveUrl, interpolateVars, resolveJsonPath, UnresolvedVariableError, getScreenshotsDir, getScreenshotBaselinesDir, getScreenshotDiffsDir } from '../utils/helpers';
import { DEFAULT_PAGE_TIMEOUT, DEFAULT_SELECTOR_TIMEOUT, SCREENSHOT_COMPARE_THRESHOLD, DEFAULT_BROWSER_RETRIES, DEFAULT_RETRY_DELAY } from '../utils/constants';

const MAX_CAPTURE_BYTES = 8192;

function capString(s: string): string {
  const buf = Buffer.from(s);
  if (buf.length <= MAX_CAPTURE_BYTES) return s;
  return buf.subarray(0, MAX_CAPTURE_BYTES).toString('utf-8') + `\n... [truncated ${buf.length - MAX_CAPTURE_BYTES} bytes]`;
}

// URL matching for wait_for_response: "*" wildcards or a plain substring.
function urlMatches(pattern: string, url: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern);
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

// Validates browser-level expectations against the current page state.
// Returns an error string on failure, or null if all expectations pass.
async function checkBrowserExpectations(
  page: Page,
  step: BrowserStep,
  vars: Record<string, string>
): Promise<string | null> {
  const expect = step.expect;
  if (!expect) return null;

  if (expect.has_text) {
    const text = await page.textContent('body');
    const expected = interpolateVars(expect.has_text, vars, step.name);
    if (!text || !text.includes(expected)) {
      return `Page body does not contain text: "${expected}"`;
    }
  }

  if (expect.not_has_text) {
    const text = await page.textContent('body');
    const expected = interpolateVars(expect.not_has_text, vars, step.name);
    if (text && text.includes(expected)) {
      return `Page body contains unexpected text: "${expected}"`;
    }
  }

  if (expect.url_contains) {
    const currentUrl = page.url();
    const expected = interpolateVars(expect.url_contains, vars, step.name);
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

// Executes a single browser step (navigate, click, fill, etc.) with retries.
// Retries are disabled for evaluate, screenshot, and screenshot_compare actions.
export async function executeBrowserStep(
  step: BrowserStep,
  page: Page,
  base_url: string | undefined,
  vars: Record<string, string>,
  signal?: AbortSignal,
): Promise<StepMetrics> {
  const noRetry = step.action === 'browser.evaluate' || step.action === 'browser.screenshot' || step.action === 'browser.screenshot_compare';
  const maxRetries = noRetry ? 0 : (step.retries ?? DEFAULT_BROWSER_RETRIES);
  const retryDelay = step.retry_delay ?? DEFAULT_RETRY_DELAY;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    const stepMetrics: StepMetrics = {
      step_name: step.name,
      action: step.action,
      success: false,
      response_time_ms: 0,
      attempts: attempt + 1,
      timestamp: new Date(),
    };

    try {
      if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
      switch (step.action) {
        case 'browser.navigate': {
          if (!step.url) throw new Error('browser.navigate requires a "url" field');
          const resolvedBase = base_url === undefined ? undefined : interpolateVars(base_url, vars, step.name);
          const resolvedUrl = resolveUrl(resolvedBase, interpolateVars(step.url, vars, step.name));
          stepMetrics.request_url = resolvedUrl;
          stepMetrics.request_method = 'GET';
          try {
            await page.goto(resolvedUrl, { waitUntil: 'load', timeout: DEFAULT_PAGE_TIMEOUT });
          } catch {
            // Fallback to domcontentloaded if 'load' event doesn't fire
            await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_PAGE_TIMEOUT });
          }
          break;
        }

        case 'browser.fill': {
          if (!step.selector) throw new Error('browser.fill requires a "selector" field');
          if (step.value === undefined) throw new Error('browser.fill requires a "value" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          // Uses native setter dispatch for reliable React/Angular form control compatibility
          const sel = JSON.stringify(step.selector);
          const val = JSON.stringify(interpolateVars(step.value, vars, step.name));
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
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const typedSel = JSON.stringify(step.selector);
          const typedVal = JSON.stringify(interpolateVars(step.value, vars, step.name));
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
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.click(step.selector);
          break;
        }

        case 'browser.check': {
          if (!step.selector) throw new Error('browser.check requires a "selector" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.check(step.selector);
          break;
        }

        case 'browser.uncheck': {
          if (!step.selector) throw new Error('browser.uncheck requires a "selector" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.uncheck(step.selector);
          break;
        }

        case 'browser.hover': {
          if (!step.selector) throw new Error('browser.hover requires a "selector" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.hover(step.selector);
          break;
        }

        case 'browser.clear': {
          if (!step.selector) throw new Error('browser.clear requires a "selector" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.locator(step.selector).fill('');
          break;
        }

        case 'browser.press': {
          if (!step.value) throw new Error('browser.press requires a "value" field (key name)');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          if (step.selector) await page.focus(step.selector);
          await page.keyboard.press(interpolateVars(step.value, vars, step.name));
          break;
        }

        case 'browser.upload_file': {
          if (!step.selector) throw new Error('browser.upload_file requires a "selector" field');
          if (!step.value) throw new Error('browser.upload_file requires a "value" field (file path)');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const filePath = path.resolve(interpolateVars(step.value, vars, step.name));
          if (!fs.existsSync(filePath)) throw new Error(`Upload file not found: ${filePath}`);
          await page.setInputFiles(step.selector, filePath);
          break;
        }

        case 'browser.wait_for_response': {
          if (!step.url) throw new Error('browser.wait_for_response requires a "url" field (URL pattern)');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const pattern = interpolateVars(step.url, vars, step.name);
          const method = step.value ? interpolateVars(step.value, vars, step.name).toUpperCase() : undefined;
          const response = await page.waitForResponse(
            res => urlMatches(pattern, res.url()) && (!method || res.request().method() === method),
            { timeout: step.timeout ?? DEFAULT_PAGE_TIMEOUT },
          );
          stepMetrics.status_code = response.status();
          break;
        }

        case 'browser.assert': {
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const expected = step.value !== undefined ? interpolateVars(step.value, vars, step.name) : undefined;
          if (step.selector) {
            const locator = page.locator(step.selector).first();
            await locator.waitFor({ state: 'visible', timeout: step.timeout ?? DEFAULT_SELECTOR_TIMEOUT });
            if (expected !== undefined) {
              const text = (await locator.textContent()) ?? '';
              if (!text.includes(expected)) {
                throw new Error(`Selector "${step.selector}" text does not contain "${expected}" (got "${text}")`);
              }
            }
          } else if (expected !== undefined) {
            const body = (await page.textContent('body')) ?? '';
            if (!body.includes(expected)) {
              throw new Error(`Page body does not contain "${expected}"`);
            }
          }
          // Additional has_text/url_contains/selector_count checks run below via expect.
          break;
        }

        case 'browser.select': {
          if (!step.selector) throw new Error('browser.select requires a "selector" field');
          if (step.value === undefined) throw new Error('browser.select requires a "value" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.selectOption(step.selector, interpolateVars(step.value, vars, step.name));
          break;
        }

        case 'browser.wait_for': {
          if (!step.selector) throw new Error('browser.wait_for requires a "selector" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          await page.waitForSelector(step.selector, { timeout: step.timeout || DEFAULT_SELECTOR_TIMEOUT });
          break;
        }

        case 'browser.screenshot': {
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const screenshotsDir = getScreenshotsDir();
          const filename = step.value && path.isAbsolute(step.value) ? step.value : path.join(screenshotsDir, step.value || `screenshot-${Date.now()}.png`);
          await page.screenshot({ path: filename, fullPage: true });
          stepMetrics.error = `Screenshot saved: ${filename}`;
          break;
        }

        case 'browser.screenshot_compare': {
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const baselinesDir = getScreenshotBaselinesDir();
          const diffsDir = getScreenshotDiffsDir();
          const basePath = step.value && path.isAbsolute(step.value) ? step.value : path.join(baselinesDir, step.value || `baseline-${step.name}.png`);
          const currentPath = path.join(diffsDir, `current-${step.name}-${Date.now()}.png`);
          await page.screenshot({ path: currentPath, fullPage: true });
          if (!fs.existsSync(basePath)) {
            // First run — save as baseline and skip comparison
            fs.mkdirSync(path.dirname(basePath), { recursive: true });
            fs.renameSync(currentPath, basePath);
            stepMetrics.error = `Baseline created at ${basePath}`;
            throw new Error('Baseline created — no comparison performed');
          }
          const baseBuf = fs.readFileSync(basePath);
          const curBuf = fs.readFileSync(currentPath);
          if (baseBuf.length !== curBuf.length) {
            const diff = Math.abs(baseBuf.length - curBuf.length) / Math.max(baseBuf.length, curBuf.length);
            if (diff > SCREENSHOT_COMPARE_THRESHOLD) {
              throw new Error(`Screenshot differs from baseline (size diff ${(diff * 100).toFixed(1)}%)`);
            }
            fs.unlinkSync(currentPath);
          } else {
            fs.unlinkSync(currentPath);
          }
          break;
        }

        case 'browser.scroll': {
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          if (step.value !== undefined) {
            await page.evaluate(`window.scrollBy(0, ${Number(step.value)})`);
          } else if (step.selector) {
            await page.locator(step.selector).scrollIntoViewIfNeeded();
          }
          break;
        }

        case 'browser.evaluate': {
          if (!step.script) throw new Error('browser.evaluate requires a "script" field');
          if (signal?.aborted) throw new Error(`Step "${step.name}" aborted by user`);
          const result = await page.evaluate(step.script);
          if (step.variables && result !== undefined) {
            for (const [key, path] of Object.entries(step.variables)) {
              const resolved = resolveJsonPath(result, path);
              if (resolved !== undefined) {
                vars[key] = String(resolved);
              }
            }
          }
          break;
        }
      }

      stepMetrics.response_time_ms = Date.now() - start;

      try {
        stepMetrics.request_url = stepMetrics.request_url ?? page.url();
        stepMetrics.response_headers = { url: page.url() };
        const body = await page.content().catch(() => '');
        if (body) stepMetrics.response_body = capString(body);
      } catch { /* ignore */ }

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
      try {
        if (!stepMetrics.request_url) stepMetrics.request_url = page.url();
        stepMetrics.response_headers = { url: page.url() };
        const body = await page.content().catch(() => '');
        if (body) stepMetrics.response_body = capString(body);
      } catch { /* ignore */ }
      // Missing variables will not resolve on retry.
      if (err instanceof UnresolvedVariableError) return stepMetrics;
    }

    // Return on success or final attempt — otherwise retry
    if (stepMetrics.success || attempt === maxRetries) {
      return stepMetrics;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  throw new Error('Retry exhausted');
}
