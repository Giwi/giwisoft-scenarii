import { DiscordConfig } from '../settings';
import { ScenarioMetrics } from '../types';
import logger from '../logger';
import { fetchWithRetry } from '../retry';

// Sends a scenario failure/recovery notification via a Discord webhook.
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

  const body = {
    embeds: [{
      title: `Scenario ${statusText}: ${metrics.scenario_name}`,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };

  const res = await fetchWithRetry(config.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, err }, 'Discord notification failed');
  }
}
