import { WebhookConfig } from '../settings';
import { ScenarioMetrics } from '../types';
import logger from '../logger';
import { fetchWithRetry } from '../retry';

export async function sendWebhook(
  config: WebhookConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
  const body = {
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

  const res = await fetchWithRetry(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, err }, 'Webhook notification failed');
  }
}
