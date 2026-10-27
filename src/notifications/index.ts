import { getSettings, NotificationsConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { getPreviousRunSuccess } from '../config/storage';
import { recordNotificationDelivery } from '../metrics/metrics-exporter';
import { sendTelegram } from './telegram';
import { sendEmail } from './email-client';
import { sendSlack } from './slack';
import { sendDiscord } from './discord';
import { sendWebhook } from './webhook';
import { sendTeams } from './teams';
import { sendNtfy } from './ntfy';
import { sendPagerDuty } from './pagerduty';
import logger from '../utils/logger';

// True when notifications are globally muted, or the current time is inside the
// configured maintenance window. Invalid timestamps are ignored rather than muting
// forever by accident.
export function notificationsSuppressed(config: NotificationsConfig): boolean {
  if (config.muted) return true;
  const maintenance = config.maintenance;
  if (!maintenance?.enabled) return false;
  const now = Date.now();
  const start = maintenance.start ? Date.parse(maintenance.start) : NaN;
  const end = maintenance.end ? Date.parse(maintenance.end) : NaN;
  // Fail open on a typo rather than silently silencing alerts forever.
  if (maintenance.start && Number.isNaN(start)) return false;
  if (maintenance.end && Number.isNaN(end)) return false;
  if (!Number.isNaN(start) && now < start) return false;
  if (!Number.isNaN(end) && now > end) return false;
  return true;
}

// Dispatches notifications across all configured channels when a scenario's state
// transitions from pass→fail or fail→pass. Skips if the previous run was the same state.
export async function notifyIfStateChanged(metrics: ScenarioMetrics): Promise<void> {
  const settings = getSettings();
  if (!settings.notifications) return;
  if (notificationsSuppressed(settings.notifications)) {
    logger.info({ scenario: metrics.scenario_name }, 'Notifications suppressed (muted or maintenance window)');
    return;
  }

  let prevSuccess: boolean | null;
  try {
    prevSuccess = await getPreviousRunSuccess(metrics.scenario_name);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to get previous run success');
    return;
  }

  // No previous run — notify on failure, skip on success
  if (prevSuccess === null) {
    if (metrics.success) return;
  } else if (prevSuccess === metrics.success) {
    return;
  }

  const currentSuccess = metrics.success;
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

  if (settings.notifications.teams?.enabled) {
    promises.push(sendTeams(settings.notifications.teams, metrics, event));
  }

  if (settings.notifications.ntfy?.enabled) {
    promises.push(sendNtfy(settings.notifications.ntfy, metrics, event));
  }

  if (settings.notifications.pagerduty?.enabled) {
    promises.push(sendPagerDuty(settings.notifications.pagerduty, metrics, event));
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
