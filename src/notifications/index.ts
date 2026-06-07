import { getSettings } from '../settings';
import { ScenarioMetrics } from '../types';
import { getPreviousRunSuccess } from '../storage';
import { sendTelegram } from './telegram';
import { sendEmail } from './mailgun';
import logger from '../logger';

export async function notifyIfStateChanged(metrics: ScenarioMetrics): Promise<void> {
  const settings = getSettings();
  if (!settings.notifications) return;

  let prevSuccess: boolean | null;
  try {
    prevSuccess = getPreviousRunSuccess(metrics.scenario_name);
  } catch (err) {
    logger.error({ err }, 'Failed to get previous run success');
    return;
  }

  if (prevSuccess === null) return;

  const currentSuccess = metrics.success;
  if (prevSuccess === currentSuccess) return;

  const event = currentSuccess ? 'recovery' : 'failure';
  const promises: Promise<void>[] = [];

  if (settings.notifications.telegram?.enabled) {
    promises.push(sendTelegram(settings.notifications.telegram, metrics, event));
  }

  if (settings.notifications.email?.enabled) {
    promises.push(sendEmail(settings.notifications.email, metrics, event));
  }

  if (promises.length === 0) return;

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'Notification delivery failed');
    }
  }
}
