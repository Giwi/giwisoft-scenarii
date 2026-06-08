import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveUrl, interpolateVars, resolveJsonPath } from '../src/helpers';

describe('resolveUrl', () => {
  it('returns absolute URLs unchanged', () => {
    assert.strictEqual(resolveUrl(undefined, 'https://example.com/path'), 'https://example.com/path');
    assert.strictEqual(resolveUrl('http://base.com', 'http://other.com'), 'http://other.com');
  });

  it('resolves relative URL against base_url', () => {
    assert.strictEqual(resolveUrl('https://example.com', '/api/test'), 'https://example.com/api/test');
  });

  it('handles trailing slash on base_url and leading slash on path', () => {
    assert.strictEqual(resolveUrl('https://example.com/', '/api'), 'https://example.com/api');
    assert.strictEqual(resolveUrl('https://example.com', 'api'), 'https://example.com/api');
    assert.strictEqual(resolveUrl('https://example.com/', 'api'), 'https://example.com/api');
  });

  it('throws when base_url is missing for relative URL', () => {
    assert.throws(() => resolveUrl(undefined, '/path'), /No base_url configured/);
  });
});

describe('interpolateVars', () => {
  it('replaces {{variable}} with values from vars', () => {
    assert.strictEqual(interpolateVars('/api/{{token}}', { token: 'abc' }), '/api/abc');
  });

  it('replaces multiple variables', () => {
    assert.strictEqual(interpolateVars('{{a}}-{{b}}-{{a}}', { a: '1', b: '2' }), '1-2-1');
  });

  it('leaves unknown variables as-is', () => {
    assert.strictEqual(interpolateVars('/api/{{missing}}', {}), '/api/{{missing}}');
  });

  it('handles strings with no variables', () => {
    assert.strictEqual(interpolateVars('plain string', {}), 'plain string');
  });
});

describe('resolveJsonPath', () => {
  it('resolves simple paths', () => {
    assert.strictEqual(resolveJsonPath({ a: 1 }, 'a'), 1);
  });

  it('resolves nested paths', () => {
    assert.strictEqual(resolveJsonPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  });

  it('resolves array index paths', () => {
    assert.strictEqual(resolveJsonPath({ items: [10, 20, 30] }, 'items[1]'), 20);
  });

  it('returns undefined for missing paths', () => {
    assert.strictEqual(resolveJsonPath({ a: 1 }, 'b'), undefined);
  });

  it('returns undefined for null/undefined intermediate', () => {
    assert.strictEqual(resolveJsonPath({ a: null }, 'a.b'), undefined);
  });

  it('handles $ prefix', () => {
    assert.strictEqual(resolveJsonPath({ x: 'y' }, '$.x'), 'y');
  });

  it('returns undefined for bare $ (no dot after it)', () => {
    assert.strictEqual(resolveJsonPath({ foo: 'bar' }, '$'), undefined);
  });
});
