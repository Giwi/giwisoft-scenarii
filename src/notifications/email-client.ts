import { EmailConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import logger from '../utils/logger';
import { fetchWithRetry, retryAsync, NOTIFICATION_RETRIES } from '../utils/retry';
import { sendSmtpEmail } from './smtp-client';

// Sends one message through Mailgun. Kept exported for any direct caller.
export async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  from: string,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const auth = btoa(`api:${apiKey}`);
  const url = `https://api.mailgun.net/v3/${domain}/messages`;

  for (const recipient of to) {
    const form = new URLSearchParams();
    form.set('from', from);
    form.set('to', recipient);
    form.set('subject', subject);
    form.set('text', text);

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    }, NOTIFICATION_RETRIES);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Mailgun notification failed: ${res.status} ${err}`);
    }
  }
}

// Resolves the sender address: the shared email.from, else the legacy mailgun.from.
function sender(email: EmailConfig): string {
  return email.from ?? email.mailgun?.from ?? '';
}

// Sends one message through whichever transport is configured. SMTP wins when both are
// present. Throws when no usable transport is configured so the caller can log it.
export async function sendEmailMessage(
  email: EmailConfig,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const from = sender(email);
  if (!from) {
    throw new Error('Email sender (from) is not configured');
  }

  const smtp = email.smtp;
  if (smtp?.host) {
    await retryAsync(() => sendSmtpEmail(smtp, from, to, subject, text), 'SMTP send');
    return;
  }

  const mailgun = email.mailgun;
  if (mailgun?.api_key && mailgun.domain) {
    await sendMailgunEmail(mailgun.api_key, mailgun.domain, from, to, subject, text);
    return;
  }

  throw new Error('No email transport configured (set email.smtp.host or email.mailgun)');
}

export async function sendEmail(
  config: EmailConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery'
): Promise<void> {
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
    await sendEmailMessage(config, config.to, subject, body);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Email notification error');
    throw err;
  }
}
