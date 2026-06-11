import { EmailConfig } from '../settings';
import { ScenarioMetrics } from '../types';
import logger from '../logger';
import { sendMailgunEmail } from '../email';

// Sends a scenario failure/recovery notification via the Mailgun email API.
export async function sendEmail(
  config: EmailConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
  const { mailgun } = config;
  const subject = event === 'failure'
    ? `🔴 FAILED: ${metrics.scenario_name}`
    : `🟢 RECOVERED: ${metrics.scenario_name}`;

  const failedSteps = metrics.steps.filter(s => !s.success);
  let body = `Scenario: ${metrics.scenario_name}\n`
    + `Status: ${event === 'failure' ? 'FAILED' : 'RECOVERED'}\n`
    + `Duration: ${metrics.duration_ms}ms\n`
    + `Passed: ${metrics.steps.filter(s => s.success).length}/${metrics.steps.length}\n`;

  if (failedSteps.length > 0) {
    body += '\nFailed steps:\n';
    for (const step of failedSteps) {
      body += `  - ${step.step_name}${step.error ? ': ' + step.error : ''}\n`;
    }
  }

  try {
    await sendMailgunEmail(mailgun.api_key, mailgun.domain, mailgun.from, config.to, subject, body);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Mailgun notification error');
  }
}
