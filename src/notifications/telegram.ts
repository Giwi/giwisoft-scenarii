import { TelegramConfig } from '../settings';
import { ScenarioMetrics } from '../types';
import logger from '../logger';
import { fetchWithRetry } from '../retry';

// Sends a scenario failure/recovery notification via the Telegram Bot API.
export async function sendTelegram(
  config: TelegramConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
  const emoji = event === 'failure' ? '🔴' : '🟢';
  const label = event === 'failure' ? 'FAILED' : 'RECOVERED';
  const lines = [
    `${emoji} Scenario **${label}**: ${metrics.scenario_name}`,
    `Duration: ${metrics.duration_ms}ms`,
    `Steps: ${metrics.steps.filter(s => s.success).length}/${metrics.steps.length} passed`,
  ];

  const failedSteps = metrics.steps.filter(s => !s.success);
  if (failedSteps.length > 0) {
    lines.push('', 'Failed steps:');
    for (const step of failedSteps) {
      lines.push(`  • ${step.step_name}${step.error ? ': ' + step.error : ''}`);
    }
  }

  const text = lines.join('\n');

  const url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
  const body = {
    chat_id: config.chat_id,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, err }, 'Telegram notification failed');
  }
}
