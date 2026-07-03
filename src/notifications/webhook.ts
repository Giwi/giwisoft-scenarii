import { WebhookConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { postJson } from '../utils/retry';

export async function sendWebhook(
  config: WebhookConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
  await postJson(config.url, {
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
  }, 'Webhook');
}
