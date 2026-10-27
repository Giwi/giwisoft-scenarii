import crypto from 'crypto';
import { WebhookConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { fetchWithRetry } from '../utils/retry';

type NotificationEvent = 'failure' | 'recovery';

// Payload sent to generic webhooks. Kept stable for existing consumers.
export function webhookPayload(metrics: ScenarioMetrics, event: NotificationEvent): Record<string, unknown> {
  return {
    event,
    scenario: metrics.scenario_name,
    success: metrics.success,
    duration_ms: metrics.duration_ms,
    started_at: metrics.started_at.toISOString(),
    finished_at: metrics.finished_at.toISOString(),
    steps: metrics.steps.map(s => ({
      step_name: s.step_name,
      action: s.action,
      success: s.success,
      response_time_ms: s.response_time_ms,
      error: s.error || null,
      status_code: s.status_code || null,
    })),
  };
}

// Resolves {{path.to.value}} placeholders against the payload. Unknown paths become "".
function lookup(payload: Record<string, unknown>, path: string): string {
  let current: unknown = payload;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return '';
    if (typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) return '';
  if (typeof current === 'object') return JSON.stringify(current);
  return String(current);
}

export function renderWebhookTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => lookup(payload, path));
}

export interface WebhookRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

// Builds the outgoing request, including headers, template rendering, and HMAC signing.
// Exported for tests.
export function buildWebhookRequest(
  config: WebhookConfig,
  metrics: ScenarioMetrics,
  event: NotificationEvent,
): WebhookRequest {
  const payload = webhookPayload(metrics, event);
  const body = config.template
    ? renderWebhookTemplate(config.template, payload)
    : JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': config.template ? 'text/plain; charset=utf-8' : 'application/json',
    ...(config.headers ?? {}),
  };

  if (config.signing_secret) {
    const signature = crypto.createHmac('sha256', config.signing_secret).update(body).digest('hex');
    headers[config.signing_header || 'X-Scenarii-Signature'] = `${config.signature_prefix ?? 'sha256='}${signature}`;
  }

  return {
    url: config.url,
    method: config.method ?? 'POST',
    headers,
    body,
  };
}

export async function sendWebhook(
  config: WebhookConfig,
  metrics: ScenarioMetrics,
  event: NotificationEvent,
): Promise<void> {
  const request = buildWebhookRequest(config, metrics, event);
  const res = await fetchWithRetry(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webhook notification failed: ${res.status} ${err}`);
  }
}
