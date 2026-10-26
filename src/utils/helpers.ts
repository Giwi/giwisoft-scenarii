// Utility functions shared across the server: URL resolution, variable interpolation,
// JSON path resolution, port polling, and various output-formatting helpers (CSV, Prometheus, HTML).

import net from 'net';
import { ScenarioMetrics } from '../types';
import { DEFAULT_HISTORY_DAYS, MIN_DAYS, MAX_DAYS } from './constants';

// Polls a TCP port until it becomes reachable or the timeout is exceeded.
export function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
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

// Resolves a URL against an optional base URL. Absolute URLs pass through unchanged.
export function resolveUrl(base_url: string | undefined, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!base_url) throw new Error('No base_url configured and url is relative');
  return `${base_url.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

export class UnresolvedVariableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedVariableError';
  }
}

type VariableLookup = (name: string) => string | undefined;

function appendContext(message: string, context?: string): string {
  return context ? `${message} in ${context}` : message;
}

// Empty environment variables count as unset, so a default (or a clear error) applies.
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

// Replaces {{var}}, {{env.NAME}}, and {{var:-fallback}} placeholders.
// A fallback is used when the value is missing or empty. Undefined values throw
// instead of sending a request with a literal placeholder.
function renderTemplate(template: string, lookup: VariableLookup, context?: string): string {
  return template.replace(/\{\{([\w.]+)(?::-([^{}]*))?\}\}/g, (_, name: string, fallback?: string) => {
    const value = lookup(name);

    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return renderTemplate(fallback, lookup, context);
    if (value === '') return '';

    const message = name.startsWith('env.')
      ? `Unresolved environment variable "${name.slice(4)}"`
      : `Unresolved variable "{{${name}}}"`;
    throw new UnresolvedVariableError(appendContext(message, context));
  });
}

// Replaces placeholders in a template using runtime variables and process.env.
export function interpolateVars(template: string, vars: Record<string, string>, stepName?: string): string {
  const context = stepName ? `step "${stepName}"` : undefined;
  return renderTemplate(template, (name) => {
    if (name.startsWith('env.')) return readEnv(name.slice(4));
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
  }, context);
}

// Resolves scenario-level variables before a run starts. Definitions may reference
// process environment variables and other definitions, in any order.
export function resolveVariableDefinitions(
  definitions: Record<string, string> | undefined,
  context?: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (!definitions) return resolved;

  const stack: string[] = [];

  const lookup: VariableLookup = (name) => {
    if (name.startsWith('env.')) return readEnv(name.slice(4));
    if (!Object.prototype.hasOwnProperty.call(definitions, name)) return undefined;
    if (Object.prototype.hasOwnProperty.call(resolved, name)) return resolved[name];

    const cycleStart = stack.indexOf(name);
    if (cycleStart !== -1) {
      const chain = [...stack.slice(cycleStart), name].join(' -> ');
      throw new UnresolvedVariableError(appendContext(`Circular variable reference "${chain}"`, context));
    }

    stack.push(name);
    try {
      const value = renderTemplate(definitions[name], lookup, context);
      resolved[name] = value;
      return value;
    } finally {
      stack.pop();
    }
  };

  for (const name of Object.keys(definitions)) lookup(name);
  return resolved;
}

// Merges shared scenario headers with step headers. Header names are case-insensitive,
// so a step can override a scenario header regardless of casing.
export function mergeHeaders(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !override) return undefined;

  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(base ?? {})) merged[name] = value;

  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Navigates a parsed JSON object using a dot-notation path (e.g. $.data.items[0].id).
// Returns the value at that path, or undefined if any segment is missing.
export function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace('$.', '').split('.');
  let value: unknown = obj;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      value = (value as Record<string, unknown>)[arrMatch[1]];
      if (Array.isArray(value)) value = value[parseInt(arrMatch[2])];
      else return undefined;
    } else {
      value = (value as Record<string, unknown>)[part];
    }
  }
  return value;
}

// Escapes a string for use in Prometheus label values.
export function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Escapes a string for CSV output (wraps in quotes if needed).
export function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// Converts an array of ScenarioMetrics into CSV format with step-level detail.
export function toCsv(history: ScenarioMetrics[]): string {
  const header = 'started_at,finished_at,duration_ms,success,step_name,step_action,step_success,step_response_time_ms,step_error\n';
  const rows = history.flatMap(r =>
    r.steps.map(s =>
      `${r.started_at.toISOString()},${r.finished_at.toISOString()},${r.duration_ms},${r.success},${escapeCsv(s.step_name)},${escapeCsv(s.action)},${s.success},${s.response_time_ms},${escapeCsv(s.error || '')}`
    )
  );
  return header + rows.join('\n');
}

// Parses the "days" query parameter within valid bounds.
export function parseDaysParam(value: string | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_DAYS;
  const n = parseInt(value);
  if (isNaN(n) || n < MIN_DAYS || n > MAX_DAYS) return DEFAULT_HISTORY_DAYS;
  return n;
}

// Parses the "limit" query parameter into a number or undefined.
export function parseLimitParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value);
  return isNaN(n) ? undefined : n;
}
