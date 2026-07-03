import { SlackConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { postJson } from '../utils/retry';

export async function sendSlack(
  config: SlackConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
  const color = event === 'failure' ? '#f43f5e' : '#10b981';
  const statusText = event === 'failure' ? 'FAILED' : 'RECOVERED';

  const failedSteps = metrics.steps.filter(s => !s.success);
  const fields = [
    { title: 'Duration', value: `${metrics.duration_ms}ms`, short: true },
    { title: 'Steps', value: `${metrics.steps.filter(s => s.success).length}/${metrics.steps.length} passed`, short: true },
  ];

  if (failedSteps.length > 0) {
    fields.push({
      title: 'Failed Steps',
      value: failedSteps.map(s => `• ${s.step_name}${s.error ? ': ' + s.error : ''}`).join('\n'),
      short: false,
    });
  }

  await postJson(config.webhook_url, {
    attachments: [{
      color,
      title: `Scenario ${statusText}: ${metrics.scenario_name}`,
      fields,
      ts: Math.floor(Date.now() / 1000),
    }],
  }, 'Slack');
}
