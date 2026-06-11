import logger from './logger';

// Delay (ms) between browser step retry attempts
export const RETRY_DELAYS = [1000, 2000];
// Max retries for browser actions
export const BROWSER_RETRIES = 2;
// Max retries for notification delivery
export const NOTIFICATION_RETRIES = 3;

// Fetches a URL with retries on non-OK responses. Throws only after exhausting all retries.
export async function fetchWithRetry(url: string, options: RequestInit, retries = NOTIFICATION_RETRIES): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok || attempt === retries) return res;
    logger.warn({ attempt, status: res.status }, 'Retrying failed request');
    await new Promise(r => setTimeout(r, attempt * 1000));
  }
  throw new Error('Unreachable');
}
