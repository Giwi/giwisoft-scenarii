import { APIRequestContext } from 'playwright-core';
import { HttpStep, StepMetrics } from '../types';

function resolveUrl(base_url: string | undefined, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!base_url) throw new Error('No base_url configured and url is relative');
  return `${base_url.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function checkExpectations(step: HttpStep, response: { status(): number; headers(): Record<string, string> }, body: string, elapsed_ms: number): string | null {
  const expect = step.expect;
  if (!expect) return null;

  if (expect.status !== undefined && response.status() !== expect.status) {
    return `Expected status ${expect.status}, got ${response.status()}`;
  }

  if (expect.status_in && !expect.status_in.includes(response.status())) {
    return `Expected status in [${expect.status_in.join(', ')}], got ${response.status()}`;
  }

  if (expect.body_contains && !body.includes(expect.body_contains)) {
    return `Body does not contain expected text: "${expect.body_contains}"`;
  }

  if (expect.body_matches) {
    const re = new RegExp(expect.body_matches);
    if (!re.test(body)) {
      return `Body does not match regex: "${expect.body_matches}"`;
    }
  }

  if (expect.json_path) {
    try {
      const parsed = JSON.parse(body);
      const parts = expect.json_path.replace('$.', '').split('.');
      let value: unknown = parsed;
      for (const part of parts) {
        const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
        if (arrMatch) {
          value = (value as Record<string, unknown>)[arrMatch[1]];
          if (Array.isArray(value)) value = value[parseInt(arrMatch[2])];
          else return `JSON path "${expect.json_path}" failed at "${part}": not an array`;
        } else {
          value = (value as Record<string, unknown>)[part];
        }
      }
      if (expect.json_value !== undefined && value !== expect.json_value) {
        return `JSON path "${expect.json_path}" expected "${expect.json_value}", got "${value}"`;
      }
    } catch {
      return `Failed to parse JSON body for json_path check`;
    }
  }

  if (expect.response_time_under !== undefined && elapsed_ms > expect.response_time_under) {
    return `Response time ${elapsed_ms}ms exceeded limit of ${expect.response_time_under}ms`;
  }

  return null;
}

function extractVariables(step: HttpStep, body: string, vars: Record<string, string>): void {
  if (!step.variables) return;
  for (const [key, path] of Object.entries(step.variables)) {
    try {
      const parsed = JSON.parse(body);
      const parts = path.replace('$.', '').split('.');
      let value: unknown = parsed;
      for (const part of parts) {
        const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
        if (arrMatch) {
          value = (value as Record<string, unknown>)[arrMatch[1]];
          if (Array.isArray(value)) value = value[parseInt(arrMatch[2])];
        } else {
          value = (value as Record<string, unknown>)[part];
        }
      }
      vars[key] = String(value);
    } catch {
      // silently skip variable extraction on failure
    }
  }
}

function interpolateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export async function executeHttpStep(
  step: HttpStep,
  apiContext: APIRequestContext,
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
    const resolvedUrl = resolveUrl(base_url, interpolateVars(step.url, vars));
    const method = step.action.split('.')[1].toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    const headers = step.headers
      ? Object.fromEntries(
          Object.entries(step.headers).map(([k, v]) => [k, interpolateVars(v, vars)])
        )
      : undefined;

    let body: string | undefined;
    if (step.body && typeof step.body === 'object') {
      body = JSON.stringify(step.body);
    } else if (step.body) {
      body = String(step.body);
    }

    const response = await apiContext.fetch(resolvedUrl, {
      method,
      headers,
      data: body,
    });

    const elapsed = Date.now() - start;
    const responseBody = await response.text();

    stepMetrics.status_code = response.status();
    stepMetrics.response_time_ms = elapsed;

    const error = checkExpectations(step, response, responseBody, elapsed);
    if (error) {
      stepMetrics.success = false;
      stepMetrics.error = error;
    } else {
      stepMetrics.success = true;
    }

    extractVariables(step, responseBody, vars);
  } catch (err: unknown) {
    stepMetrics.success = false;
    stepMetrics.error = err instanceof Error ? err.message : String(err);
    stepMetrics.response_time_ms = Date.now() - start;
  }

  return stepMetrics;
}
