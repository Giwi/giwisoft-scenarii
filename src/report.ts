import { getScenarioList, getScenarioHistory } from './storage';
import { getSettings } from './settings';
import { sendEmail } from './notifications/mailgun';

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
  for (const recipient of to) {
    const form = new URLSearchParams();
    form.set('from', mailgun.from);
    form.set('to', recipient);
    form.set('subject', 'Daily Scenario Report');
    form.set('text', lines.join('\n'));
    const auth = btoa(`api:${mailgun.api_key}`);
    await fetch(`https://api.mailgun.net/v3/${mailgun.domain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  }
}
