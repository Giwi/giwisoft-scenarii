import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isInTimeWindow } from '../src/scheduler';
import { TimeWindow } from '../src/types';

function makeDate(hours: number, minutes: number = 0): Date {
  const d = new Date('2026-06-28T00:00:00');
  d.setHours(hours, minutes, 0, 0);
  return d;
}

describe('isInTimeWindow', () => {
  it('returns true when time is within window', () => {
    const window: TimeWindow = { start: '09:00', end: '17:00' };
    assert.strictEqual(isInTimeWindow(makeDate(9, 0), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(12, 30), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(17, 0), window), true);
  });

  it('returns false when time is outside window', () => {
    const window: TimeWindow = { start: '09:00', end: '17:00' };
    assert.strictEqual(isInTimeWindow(makeDate(8, 59), window), false);
    assert.strictEqual(isInTimeWindow(makeDate(17, 1), window), false);
    assert.strictEqual(isInTimeWindow(makeDate(0, 0), window), false);
  });

  it('handles windows that wrap past midnight', () => {
    const window: TimeWindow = { start: '22:00', end: '06:00' };
    assert.strictEqual(isInTimeWindow(makeDate(23, 0), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(2, 0), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(6, 0), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(21, 59), window), false);
    assert.strictEqual(isInTimeWindow(makeDate(6, 1), window), false);
  });

  it('handles full-day window', () => {
    const window: TimeWindow = { start: '00:00', end: '23:59' };
    assert.strictEqual(isInTimeWindow(makeDate(0, 0), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(12, 0), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(23, 59), window), true);
  });

  it('handles single-minute precision', () => {
    const window: TimeWindow = { start: '10:30', end: '10:45' };
    assert.strictEqual(isInTimeWindow(makeDate(10, 30), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(10, 45), window), true);
    assert.strictEqual(isInTimeWindow(makeDate(10, 29), window), false);
    assert.strictEqual(isInTimeWindow(makeDate(10, 46), window), false);
  });
});
