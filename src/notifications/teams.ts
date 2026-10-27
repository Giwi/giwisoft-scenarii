import { TeamsConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { postJson } from '../utils/retry';

// Microsoft Teams incoming webhook using a MessageCard, which Teams accepts without
// requiring Power Automate or Adaptive Card schema negotiation.
export async function sendTeams(
  config: TeamsConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery',
): Promise<void> {
  const failed = metrics.steps.filter(s => !s.success);
  const color = event === 'failure' ? 'd13438' : '107c10';
  const status = event === 'failure' ? 'FAILED' : 'RECOVERED';

  const facts = [
    { name: 'Duration', value: `${metrics.duration_ms}ms` },
    { name: 'Steps', value: `${metrics.steps.filter(s => s.success).length}/${metrics.steps.length} passed` },
  ];

  const text = failed.length
    ? failed.map(s => `**${s.step_name}**${s.error ? `: ${s.error}` : ''}`).join('\n\n')
    : undefined;

  await postJson(config.webhook_url, {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: color,
    summary: `Scenario ${status}: ${metrics.scenario_name}`,
    sections: [{
      activityTitle: `Scenario ${status}: ${metrics.scenario_name}`,
      facts,
      text,
      markdown: true,
    }],
  }, 'Teams');
}
