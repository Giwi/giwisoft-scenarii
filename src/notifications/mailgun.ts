import { EmailConfig } from '../settings';
import { ScenarioMetrics } from '../types';

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok || attempt === retries) return res;
    await new Promise(r => setTimeout(r, attempt * 1000));
  }
  throw new Error('Unreachable');
}

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

  for (const recipient of config.to) {
    const form = new URLSearchParams();
    form.set('from', mailgun.from);
    form.set('to', recipient);
    form.set('subject', subject);
    form.set('text', body);

    const auth = btoa(`api:${mailgun.api_key}`);
    const url = `https://api.mailgun.net/v3/${mailgun.domain}/messages`;

    try {
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`Mailgun notification failed for ${recipient}: ${res.status} ${err}`);
      }
    } catch (err: unknown) {
      console.error(`Mailgun notification error for ${recipient}:`, err instanceof Error ? err.message : err);
    }
  }
}
