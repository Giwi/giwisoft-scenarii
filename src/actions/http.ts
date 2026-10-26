import { isDeepStrictEqual } from 'node:util';
import { HttpStep, StepMetrics } from '../types';
import { resolveUrl, interpolateVars, resolveJsonPath, mergeHeaders, UnresolvedVariableError } from '../utils/helpers';
import { DEFAULT_HTTP_RETRIES, DEFAULT_RETRY_DELAY } from '../utils/constants';

interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}

// Performs an HTTP request and returns a simplified response object.
async function doFetch(url: string, method: string, headers: Record<string, string> | undefined, body: string | undefined, signal?: AbortSignal): Promise<FetchResponse> {
  const res = await fetch(url, {
    method,
    headers: headers as Record<string, string> | undefined,
    body,
    signal,
  });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text: () => res.text(),
  };
}

// Validates HTTP response expectations against the actual response.
// Returns an error string on failure, or null if all expectations pass.
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

  if (expect.body_schema) {
    try {
      const parsed = JSON.parse(body);
      const error = validateSchema(parsed, expect.body_schema, '');
      if (error) {
        return `Body schema validation failed: ${error}`;
      }
    } catch {
      return `Failed to parse JSON body for schema validation`;
    }
  }

  return null;
}

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null'] as const;

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatValue(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

// Recursive schema validator for body_schema.
// Supports: type, properties/required, items, enum, pattern, min/max, nullable.
function validateSchema(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const label = path || 'root';
  const type = schema.type as string | undefined;

  if (type !== undefined && !(SCHEMA_TYPES as readonly string[]).includes(type)) {
    return `${label}: unknown schema type "${type}"`;
  }

  // null is allowed before the type check when the schema opts in.
  if (value === null && schema.nullable === true) return null;

  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `${label}: expected object, got ${describeType(value)}`;
    }
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        const childPath = path ? `${path}.${key}` : key;
        if (key in (value as Record<string, unknown>)) {
          const err = validateSchema((value as Record<string, unknown>)[key], propSchema, childPath);
          if (err) return err;
        }
      }
    }
    const required = schema.required as string[] | undefined;
    if (required) {
      for (const key of required) {
        if (!(key in (value as Record<string, unknown>))) {
          return `${label}: missing required field "${key}"`;
        }
      }
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      return `${label}: expected array, got ${describeType(value)}`;
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateSchema(value[i], items, `${path}[${i}]`);
        if (err) return err;
      }
    }
  } else if (type === 'string') {
    if (typeof value !== 'string') return `${label}: expected string, got ${describeType(value)}`;
  } else if (type === 'number') {
    if (typeof value !== 'number') return `${label}: expected number, got ${describeType(value)}`;
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return `${label}: expected boolean, got ${describeType(value)}`;
  } else if (type === 'null') {
    if (value !== null) return `${label}: expected null`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(option => isDeepStrictEqual(option, value))) {
    const options = schema.enum.map(formatValue).join(', ');
    return `${label}: expected one of ${options}, got ${formatValue(value)}`;
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') return `${label}: pattern must be a string`;
    if (typeof value === 'string') {
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        return `${label}: invalid pattern "${schema.pattern}"`;
      }
      if (!pattern.test(value)) {
        return `${label}: value does not match pattern "${schema.pattern}"`;
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.min === 'number' && value < schema.min) {
      return `${label}: expected at least ${schema.min}, got ${value}`;
    }
    if (typeof schema.max === 'number' && value > schema.max) {
      return `${label}: expected at most ${schema.max}, got ${value}`;
    }
  }

  return null;
}

// Extracts variables from the JSON response body using JSONPath expressions
// defined in the step's "variables" field.
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

// Interpolates {{variables}} in string values anywhere inside a JSON body.
function interpolateBody(value: unknown, vars: Record<string, string>, stepName: string): unknown {
  if (typeof value === 'string') return interpolateVars(value, vars, stepName);
  if (Array.isArray(value)) return value.map(item => interpolateBody(item, vars, stepName));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, interpolateBody(item, vars, stepName)])
    );
  }
  return value;
}

// Executes a single HTTP step (GET/POST/PUT/PATCH/DELETE) and validates expectations.
// Retries on failure up to step.retries (default 0) with step.retry_delay between attempts.
export async function executeHttpStep(
  step: HttpStep,
  base_url: string | undefined,
  vars: Record<string, string>,
  scenarioHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<StepMetrics> {
  const maxRetries = step.retries ?? DEFAULT_HTTP_RETRIES;
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
      const resolvedBase = base_url === undefined ? undefined : interpolateVars(base_url, vars, step.name);
      const resolvedUrl = resolveUrl(resolvedBase, interpolateVars(step.url, vars, step.name));
      const method = step.action.split('.')[1].toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      const headerSource = mergeHeaders(scenarioHeaders, step.headers);
      let headers = headerSource
        ? Object.fromEntries(
            Object.entries(headerSource).map(([k, v]) => [k, interpolateVars(v, vars, step.name)])
          )
        : undefined;

      let body: string | undefined;
      if (step.body && typeof step.body === 'object') {
        body = JSON.stringify(interpolateBody(step.body, vars, step.name));
        // Object bodies are serialised as JSON; supply the header unless the user set one.
        if (!headers || !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
          headers = { ...(headers ?? {}), 'Content-Type': 'application/json' };
        }
      } else if (step.body) {
        body = interpolateVars(String(step.body), vars, step.name);
      }

      const response = await doFetch(resolvedUrl, method, headers, body, signal);

      const responseBody = await response.text();
      // Measure the full request, including body transfer, not just time to first byte.
      const elapsed = Date.now() - start;

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
