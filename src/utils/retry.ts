import logger from './logger';

export const NOTIFICATION_RETRIES = 3;

export async function fetchWithRetry(url: string, options: RequestInit, retries = NOTIFICATION_RETRIES): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok || attempt === retries) return res;
    logger.warn({ attempt, status: res.status }, 'Retrying failed request');
    await new Promise(r => setTimeout(r, attempt * 1000));
  }
  throw new Error('Unreachable');
}

export async function postJson(url: string, body: unknown, label: string): Promise<void> {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, err }, `${label} notification failed`);
  }
}
