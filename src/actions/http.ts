import { HttpStep, StepMetrics } from '../types';
import { resolveUrl, interpolateVars, resolveJsonPath } from '../helpers';

interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}

async function doFetch(url: string, method: string, headers: Record<string, string> | undefined, body: string | undefined): Promise<FetchResponse> {
  const res = await fetch(url, {
    method,
    headers: headers as Record<string, string> | undefined,
    body,
  });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text: () => res.text(),
  };
}

export function checkExpectations(step: HttpStep, response: FetchResponse, body: string, elapsed_ms: number): string | null {
  const expect = step.expect;
  if (!expect) return null;

  if (expect.status !== undefined && response.status !== expect.status) {
    return `Expected status ${expect.status}, got ${response.status}`;
  }

  if (expect.status_in && !expect.status_in.includes(response.status)) {
    return `Expected status in [${expect.status_in.join(', ')}], got ${response.status}`;
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

  if (expect.header_contains) {
    const [h, v] = expect.header_contains.split(':').map(s => s.trim());
    const val = response.headers[h.toLowerCase()];
    if (!val || !val.includes(v)) {
      return `Header "${h}" does not contain "${v}" (got "${val || 'undefined'}")`;
    }
  }

  if (expect.header_matches) {
    const [h, p] = expect.header_matches.split(':').map(s => s.trim());
    const val = response.headers[h.toLowerCase()];
    if (!val) {
      return `Header "${h}" not found in response`;
    }
    const re = new RegExp(p);
    if (!re.test(val)) {
      return `Header "${h}" value "${val}" does not match regex "${p}"`;
    }
  }

  if (expect.json_path) {
    try {
      const parsed = JSON.parse(body);
      const value = resolveJsonPath(parsed, expect.json_path);
      if (value === undefined) {
        return `JSON path "${expect.json_path}" not found`;
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
      const value = resolveJsonPath(parsed, path);
      if (value !== undefined) {
        vars[key] = String(value);
      }
    } catch {
      // silently skip variable extraction on failure
    }
  }
}

export async function executeHttpStep(
  step: HttpStep,
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

    const response = await doFetch(resolvedUrl, method, headers, body);

    const elapsed = Date.now() - start;
    const responseBody = await response.text();

    stepMetrics.status_code = response.status;
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
