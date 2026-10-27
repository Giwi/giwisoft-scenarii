import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { NotificationsConfig } from '../../src/config/settings';
import { notificationsSuppressed } from '../../src/notifications/index';
import { buildWebhookRequest, renderWebhookTemplate, webhookPayload } from '../../src/notifications/webhook';
import { ScenarioMetrics } from '../../src/types';

const metrics: ScenarioMetrics = {
  scenario_name: 'api smoke',
  started_at: new Date('2026-01-01T10:00:00Z'),
  finished_at: new Date('2026-01-01T10:00:01Z'),
  duration_ms: 1000,
  success: false,
  steps: [
    { step_name: 'Login', action: 'http.post', success: false, response_time_ms: 120, error: '401', timestamp: new Date() },
  ],
};

function baseConfig(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return {
    telegram: { enabled: false, bot_token: '', chat_id: '' },
    email: { enabled: false, to: [] },
    ...overrides,
  };
}

describe('webhook routing', () => {
  it('keeps the JSON payload by default', () => {
    const request = buildWebhookRequest({ enabled: true, url: 'https://example.com/hook' }, metrics, 'failure');
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.headers['Content-Type'], 'application/json');
    const body = JSON.parse(request.body);
    assert.strictEqual(body.scenario, 'api smoke');
    assert.strictEqual(body.event, 'failure');
  });

  it('supports method and custom headers', () => {
    const request = buildWebhookRequest({
      enabled: true,
      url: 'https://example.com/hook',
      method: 'PUT',
      headers: { 'X-Env': 'ci', 'Content-Type': 'application/vnd.custom+json' },
    }, metrics, 'recovery');
    assert.strictEqual(request.method, 'PUT');
    assert.strictEqual(request.headers['X-Env'], 'ci');
    assert.strictEqual(request.headers['Content-Type'], 'application/vnd.custom+json');
  });

  it('renders templates with payload placeholders', () => {
    const template = '{{event}} {{scenario}} took {{duration_ms}}ms';
    assert.strictEqual(renderWebhookTemplate(template, webhookPayload(metrics, 'failure')), 'failure api smoke took 1000ms');

    const request = buildWebhookRequest({
      enabled: true,
      url: 'https://example.com/hook',
      template,
    }, metrics, 'failure');
    assert.strictEqual(request.body, 'failure api smoke took 1000ms');
    assert.match(request.headers['Content-Type'], /text\/plain/);
  });

  it('signs the exact request body with HMAC-SHA256', () => {
    const request = buildWebhookRequest({
      enabled: true,
      url: 'https://example.com/hook',
      template: 'scenario={{scenario}}',
      signing_secret: 'secret',
      signing_header: 'X-Signature',
    }, metrics, 'failure');
    const expected = 'sha256=' + crypto.createHmac('sha256', 'secret').update(request.body).digest('hex');
    assert.strictEqual(request.headers['X-Signature'], expected);
  });
});

describe('notification suppression', () => {
  it('honours the global mute flag', () => {
    assert.strictEqual(notificationsSuppressed(baseConfig({ muted: true })), true);
    assert.strictEqual(notificationsSuppressed(baseConfig({ muted: false })), false);
  });

  it('suppresses inside a maintenance window only', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.strictEqual(notificationsSuppressed(baseConfig({
      maintenance: { enabled: true, start: past, end: future },
    })), true);
    assert.strictEqual(notificationsSuppressed(baseConfig({
      maintenance: { enabled: true, start: past, end: past },
    })), false);
    assert.strictEqual(notificationsSuppressed(baseConfig({
      maintenance: { enabled: true, start: future, end: future },
    })), false);
    assert.strictEqual(notificationsSuppressed(baseConfig({
      maintenance: { enabled: false, start: past, end: future },
    })), false);
  });

  it('ignores malformed timestamps instead of muting forever', () => {
    assert.strictEqual(notificationsSuppressed(baseConfig({
      maintenance: { enabled: true, start: 'not-a-date', end: 'also-not-a-date' },
    })), false);
    assert.strictEqual(notificationsSuppressed(baseConfig({
      maintenance: { enabled: true, start: 'not-a-date', end: new Date(Date.now() - 60_000).toISOString() },
    })), false);
  });
});
