import { getSettings } from '../settings';
import { ScenarioMetrics } from '../types';
import { getScenarioHistory } from '../storage';
import { sendTelegram } from './telegram';
import { sendEmail } from './mailgun';

function wasPreviouslySuccessful(scenarioName: string): boolean | null {
  try {
    const history = getScenarioHistory(scenarioName, 365);
    // history is ordered by created_at DESC, first entry is the current run just stored
    const previous = history[1];
    if (!previous) return null;
    return previous.success;
  } catch {
    return null;
  }
}

export async function notifyIfStateChanged(metrics: ScenarioMetrics): Promise<void> {
  const settings = getSettings();
  if (!settings.notifications) return;

  const prevSuccess = wasPreviouslySuccessful(metrics.scenario_name);

  // null = no previous run, skip notification
  if (prevSuccess === null) return;

  const currentSuccess = metrics.success;
  // No state change, skip
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

  await Promise.allSettled(promises);
}
