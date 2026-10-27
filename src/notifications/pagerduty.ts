import { PagerDutyConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { postJson } from '../utils/retry';

// PagerDuty Events API v2. Failure triggers an incident; recovery resolves the incident
// opened for the same scenario via a stable dedup_key.
export async function sendPagerDuty(
  config: PagerDutyConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery',
): Promise<void> {
  const failed = metrics.steps.filter(s => !s.success);
  const summary = event === 'failure'
    ? `Scenario FAILED: ${metrics.scenario_name}`
    : `Scenario RECOVERED: ${metrics.scenario_name}`;

  await postJson('https://events.pagerduty.com/v2/enqueue', {
    routing_key: config.routing_key,
    event_action: event === 'failure' ? 'trigger' : 'resolve',
    dedup_key: `scenarii/${metrics.scenario_name}`,
    payload: {
      summary,
      source: 'scenarii',
      severity: config.severity ?? 'critical',
      timestamp: metrics.finished_at.toISOString(),
      custom_details: {
        duration_ms: metrics.duration_ms,
        steps_total: metrics.steps.length,
        steps_failed: failed.length,
        failed_steps: failed.map(s => ({ step: s.step_name, error: s.error ?? null })),
      },
    },
  }, 'PagerDuty');
}
