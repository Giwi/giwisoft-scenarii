import { getSettings } from '../settings';
import { ScenarioMetrics } from '../types';
import { getPreviousRunSuccess, recordNotificationDelivery } from '../storage';
import { sendTelegram } from './telegram';
import { sendEmail } from './mailgun';
import { sendSlack } from './slack';
import { sendDiscord } from './discord';
import { sendWebhook } from './webhook';
import logger from '../logger';

// Dispatches notifications across all configured channels when a scenario's state
// transitions from pass→fail or fail→pass. Skips if the previous run was the same state.
export async function notifyIfStateChanged(metrics: ScenarioMetrics): Promise<void> {
  const settings = getSettings();
  if (!settings.notifications) return;

  let prevSuccess: boolean | null;
  try {
    prevSuccess = getPreviousRunSuccess(metrics.scenario_name);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to get previous run success');
    return;
  }

  // No previous run means no state change to report
  if (prevSuccess === null) return;

  const currentSuccess = metrics.success;
  // Only notify on state changes (pass→fail or fail→pass)
  if (prevSuccess === currentSuccess) return;

  const event = currentSuccess ? 'recovery' : 'failure';
  const promises: Promise<void>[] = [];

  if (settings.notifications.telegram?.enabled) {
    promises.push(sendTelegram(settings.notifications.telegram, metrics, event));
  }

  if (settings.notifications.email?.enabled) {
    promises.push(sendEmail(settings.notifications.email, metrics, event));
  }

  if (settings.notifications.slack?.enabled) {
    promises.push(sendSlack(settings.notifications.slack, metrics, event));
  }

  if (settings.notifications.discord?.enabled) {
    promises.push(sendDiscord(settings.notifications.discord, metrics, event));
  }

  if (settings.notifications.webhook?.enabled) {
    promises.push(sendWebhook(settings.notifications.webhook, metrics, event));
  }

  if (promises.length === 0) return;

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === 'rejected') {
      recordNotificationDelivery(false);
      logger.error({ err: result.reason }, 'Notification delivery failed');
    } else {
      recordNotificationDelivery(true);
    }
  }
}
