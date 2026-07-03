import { DiscordConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { postJson } from '../utils/retry';

export async function sendDiscord(
  config: DiscordConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
  const color = event === 'failure' ? 0xf43f5e : 0x10b981;
  const statusText = event === 'failure' ? 'FAILED' : 'RECOVERED';

  const failedSteps = metrics.steps.filter(s => !s.success);
  const fields = [
    { name: 'Duration', value: `${metrics.duration_ms}ms`, inline: true },
    { name: 'Steps', value: `${metrics.steps.filter(s => s.success).length}/${metrics.steps.length} passed`, inline: true },
  ];

  if (failedSteps.length > 0) {
    fields.push({
      name: 'Failed Steps',
      value: failedSteps.map(s => `• ${s.step_name}${s.error ? ': ' + s.error : ''}`).join('\n'),
      inline: false,
    });
  }

  await postJson(config.webhook_url, {
    embeds: [{
      title: `Scenario ${statusText}: ${metrics.scenario_name}`,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  }, 'Discord');
}
