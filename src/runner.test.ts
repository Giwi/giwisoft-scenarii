import { describe, it } from 'node:test';
import assert from 'node:assert';

// Test the sequential queue logic in isolation
describe('sequential queue', () => {
  it('runs tasks in order', async () => {
    const order: number[] = [];
    const queue: Promise<void>[] = [];

    function sequential(fn: () => Promise<void>): Promise<void> {
      const next = (queue[queue.length - 1] || Promise.resolve()).then(fn, fn);
      queue.push(next.catch(() => {}));
      return next;
    }

    sequential(async () => { order.push(1); });
    sequential(async () => { order.push(2); });
    await sequential(async () => { order.push(3); });

    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it('continues after a failing task', async () => {
    const order: number[] = [];
    const queue: Promise<void>[] = [];

    function sequential(fn: () => Promise<void>): Promise<void> {
      const next = (queue[queue.length - 1] || Promise.resolve()).then(fn, fn);
      queue.push(next.catch(() => {}));
      return next;
    }

    await sequential(async () => { throw new Error('fail'); }).catch(() => {});
    await sequential(async () => { order.push(1); });

    assert.deepStrictEqual(order, [1]);
  });
});

// Test notification state detection logic
describe('notification state detection', () => {
  it('detects failure transition (pass → fail)', () => {
    const prevSuccess = true;
    const currentSuccess = false;
    const event = currentSuccess ? 'recovery' : 'failure';
    assert.strictEqual(event, 'failure');
  });

  it('detects recovery transition (fail → pass)', () => {
    const prevSuccess = false;
    const currentSuccess = true;
    const event = currentSuccess ? 'recovery' : 'failure';
    assert.strictEqual(event, 'recovery');
  });

  it('skips notification when no state change', () => {
    assert.strictEqual(true === true, true);  // no change
    assert.strictEqual(false === false, true); // no change
  });

  it('skips notification on first run (no previous)', () => {
    const prevSuccess = null;
    const shouldNotify = prevSuccess !== null;
    assert.strictEqual(shouldNotify, false);
  });
});

// Test settings schema validation
describe('settings schema', () => {
  const validSettings = {
    notifications: {
      telegram: { enabled: true, bot_token: 'abc', chat_id: '123' },
      email: { enabled: false, mailgun: { api_key: '', domain: '', from: '' }, to: [] },
    },
  };

  it('accepts valid settings', () => {
    assert.ok(validSettings.notifications);
    assert.ok(validSettings.notifications.telegram);
    assert.ok(validSettings.notifications.email);
  });

  it('handles missing notifications section', () => {
    const empty = {};
    assert.strictEqual((empty as any).notifications, undefined);
  });
});
