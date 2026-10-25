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

// Posts a JSON payload and throws when the endpoint does not accept it, so callers can
// record delivery failures instead of mistaking them for success.
export async function postJson(
  url: string,
  body: unknown,
  label: string,
  retries = NOTIFICATION_RETRIES,
): Promise<void> {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, retries);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${label} notification failed: ${res.status} ${err}`);
  }
}
