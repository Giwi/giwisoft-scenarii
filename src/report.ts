import { getScenarioList, getScenarioHistory } from './storage';
import { getSettings } from './settings';
import { sendMailgunEmail } from './email';

// Generates and sends a daily summary email listing all scenarios with pass rates.
export async function sendDailyReport(): Promise<void> {
  const settings = getSettings();
  if (!settings.notifications?.email?.enabled) return;

  const scenarios = getScenarioList();
  const lines: string[] = ['Daily Scenario Report', '====================\n'];

  for (const s of scenarios) {
    const history = getScenarioHistory(s.name, 1);
    const totalRuns = history.length;
    const passedRuns = history.filter(r => r.success).length;
    const passRate = totalRuns > 0 ? Math.round(passedRuns / totalRuns * 100) : 0;
    lines.push(`  ${s.name}: ${passedRuns}/${totalRuns} passed (${passRate}%)`);
    const last = history[0];
    if (last) {
      lines.push(`    Last run: ${last.success ? 'PASS' : 'FAIL'} (${last.duration_ms}ms)`);
    }
  }

  const { mailgun, to } = settings.notifications.email;
  await sendMailgunEmail(mailgun.api_key, mailgun.domain, mailgun.from, to, 'Daily Scenario Report', lines.join('\n'));
}
