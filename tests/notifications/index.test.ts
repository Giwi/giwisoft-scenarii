import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as settingsModule from '../../src/settings';
import * as storageModule from '../../src/storage';
import * as telegramModule from '../../src/notifications/telegram';
import { ScenarioMetrics } from '../../src/types';

const metrics: ScenarioMetrics = {
  scenario_name: 'test',
  started_at: new Date(),
  finished_at: new Date(),
  duration_ms: 100,
  success: true,
  steps: [],
};

const failMetrics: ScenarioMetrics = { ...metrics, success: false };

describe('notifyIfStateChanged', () => {
  beforeEach(() => {
    mock.method(telegramModule, 'sendTelegram', () => Promise.resolve());
    mock.method(storageModule, 'recordNotificationDelivery', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('returns early when no notifications configured', async () => {
    mock.method(settingsModule, 'getSettings', () => ({ notifications: undefined }));
    const { notifyIfStateChanged } = await import('../../src/notifications/index');
    await notifyIfStateChanged(metrics);
  });

  it('returns early when no previous run', async () => {
    mock.method(settingsModule, 'getSettings', () => ({
      notifications: { telegram: { enabled: true, bot_token: 't', chat_id: 'c' } },
    }));
    mock.method(storageModule, 'getPreviousRunSuccess', () => null);
    const { notifyIfStateChanged } = await import('../../src/notifications/index');
    await notifyIfStateChanged(metrics);
  });

  it('returns early when state has not changed', async () => {
    mock.method(settingsModule, 'getSettings', () => ({
      notifications: { telegram: { enabled: true, bot_token: 't', chat_id: 'c' } },
    }));
    mock.method(storageModule, 'getPreviousRunSuccess', () => true);
    const { notifyIfStateChanged } = await import('../../src/notifications/index');
    await notifyIfStateChanged(metrics);
  });

  it('sends notification on state change (failure)', async () => {
    let recorded = false;
    mock.method(settingsModule, 'getSettings', () => ({
      notifications: { telegram: { enabled: true, bot_token: 't', chat_id: 'c' } },
    }));
    mock.method(storageModule, 'getPreviousRunSuccess', () => true);
    mock.method(storageModule, 'recordNotificationDelivery', () => { recorded = true; });
    const { notifyIfStateChanged } = await import('../../src/notifications/index');
    await notifyIfStateChanged(failMetrics);
    assert.strictEqual(recorded, true);
  });

  it('sends notification on state change (recovery)', async () => {
    let recorded = false;
    mock.method(settingsModule, 'getSettings', () => ({
      notifications: { telegram: { enabled: true, bot_token: 't', chat_id: 'c' } },
    }));
    mock.method(storageModule, 'getPreviousRunSuccess', () => false);
    mock.method(storageModule, 'recordNotificationDelivery', () => { recorded = true; });
    const { notifyIfStateChanged } = await import('../../src/notifications/index');
    await notifyIfStateChanged(metrics);
    assert.strictEqual(recorded, true);
  });

  it('handles storage error gracefully', async () => {
    mock.method(settingsModule, 'getSettings', () => ({
      notifications: { telegram: { enabled: true, bot_token: 't', chat_id: 'c' } },
    }));
    mock.method(storageModule, 'getPreviousRunSuccess', () => { throw new Error('db error'); });
    const { notifyIfStateChanged } = await import('../../src/notifications/index');
    await notifyIfStateChanged(metrics);
  });
});
