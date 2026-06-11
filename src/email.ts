import { fetchWithRetry, NOTIFICATION_RETRIES } from './retry';

// Sends an email via the Mailgun API, one recipient at a time.
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

    await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    }, NOTIFICATION_RETRIES);
  }
}
