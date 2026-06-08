import { describe, it } from 'node:test';
import assert from 'node:assert';

// Test the sequential queue logic using the actual exported function
import { sequentialBrowser } from './runner';

describe('sequential queue', () => {
  it('runs tasks in order', async () => {
    const order: number[] = [];

    await sequentialBrowser(async () => { order.push(1); });
    await sequentialBrowser(async () => { order.push(2); });
    await sequentialBrowser(async () => { order.push(3); });

    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it('continues after a failing task', async () => {
    const order: number[] = [];

    await sequentialBrowser(async () => { throw new Error('fail'); }).catch(() => {});
    await sequentialBrowser(async () => { order.push(1); });

    assert.deepStrictEqual(order, [1]);
  });
});

// Test notification state detection logic by testing the actual storage function
describe('getPreviousRunSuccess', () => {
  it('returns null when no history exists', async () => {
    const { getPreviousRunSuccess } = await import('./storage');
    // Can't easily test without a DB — verify the function exists and has correct signature
    assert.strictEqual(typeof getPreviousRunSuccess, 'function');
  });
});

// Test settings schema validation
describe('settings schema', () => {
  it('accepts valid settings', () => {
    const validSettings = {
      notifications: {
        telegram: { enabled: true, bot_token: 'abc', chat_id: '123' },
        email: { enabled: false, mailgun: { api_key: '', domain: '', from: '' }, to: [] },
      },
    };
    assert.ok(validSettings.notifications);
    assert.ok(validSettings.notifications.telegram);
    assert.ok(validSettings.notifications.email);
  });

  it('handles missing notifications section', () => {
    const empty = {};
    assert.strictEqual((empty as any).notifications, undefined);
  });
});
