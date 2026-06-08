import logger from './logger';

export const RETRY_DELAYS = [1000, 2000];
export const BROWSER_RETRIES = 2;
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
