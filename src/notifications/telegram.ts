import { TelegramConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { postJson } from '../utils/retry';

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

  await postJson(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
    chat_id: config.chat_id,
    text: lines.join('\n'),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  }, 'Telegram');
}
