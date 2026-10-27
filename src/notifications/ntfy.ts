import { NtfyConfig } from '../config/settings';
import { ScenarioMetrics } from '../types';
import { fetchWithRetry } from '../utils/retry';

// ntfy accepts a plain-text body with control headers. This keeps the payload readable
// on phones and works with both ntfy.sh and self-hosted servers.
export async function sendNtfy(
  config: NtfyConfig,
  metrics: ScenarioMetrics,
  event: 'failure' | 'recovery',
): Promise<void> {
  const url = `${config.url.replace(/\/$/, '')}/${encodeURIComponent(config.topic)}`;
  const status = event === 'failure' ? 'FAILED' : 'RECOVERED';
  const failed = metrics.steps.filter(s => !s.success);

  const lines = [
    `Scenario ${status}: ${metrics.scenario_name}`,
    `Duration: ${metrics.duration_ms}ms`,
    `Steps: ${metrics.steps.filter(s => s.success).length}/${metrics.steps.length} passed`,
  ];
  if (failed.length) {
    lines.push('', 'Failed steps:');
    for (const step of failed) lines.push(`- ${step.step_name}${step.error ? `: ${step.error}` : ''}`);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Title': `Scenario ${status}: ${metrics.scenario_name}`,
    'Priority': String(config.priority ?? (event === 'failure' ? 4 : 3)),
    'Tags': event === 'failure' ? 'warning' : 'white_check_mark',
  };
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

  const res = await fetchWithRetry(url, { method: 'POST', headers, body: lines.join('\n') });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ntfy notification failed: ${res.status} ${err}`);
  }
}
