import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveUrl, interpolateVars, resolveJsonPath, resolveVariableDefinitions, mergeHeaders } from '../src/utils/helpers';

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

  it('throws for unknown variables instead of leaving placeholders', () => {
    assert.throws(
      () => interpolateVars('/api/{{missing}}', {}),
      /Unresolved variable "\{\{missing\}\}"/,
    );
  });

  it('includes the step name when provided', () => {
    assert.throws(
      () => interpolateVars('/api/{{missing}}', {}, 'Login'),
      /Unresolved variable "\{\{missing\}\}" in step "Login"/,
    );
  });

  it('allows variables with an empty string value', () => {
    assert.strictEqual(interpolateVars('/api/{{empty}}', { empty: '' }), '/api/');
  });

  it('does not resolve inherited object properties', () => {
    assert.throws(
      () => interpolateVars('/api/{{constructor}}', {}),
      /Unresolved variable "\{\{constructor\}\}"/,
    );
  });

  it('handles strings with no variables', () => {
    assert.strictEqual(interpolateVars('plain string', {}), 'plain string');
  });

  it('reads env-backed variables', () => {
    process.env.SCENARII_TEST_TOKEN = 's3cret';
    try {
      assert.strictEqual(interpolateVars('Bearer {{env.SCENARII_TEST_TOKEN}}', {}), 'Bearer s3cret');
    } finally {
      delete process.env.SCENARII_TEST_TOKEN;
    }
  });

  it('uses defaults for missing or empty variables', () => {
    assert.strictEqual(interpolateVars('/api/{{missing:-v1}}', {}), '/api/v1');
    assert.strictEqual(interpolateVars('/api/{{empty:-v1}}', { empty: '' }), '/api/v1');
    assert.strictEqual(interpolateVars('/api/{{token:-}}', {}), '/api/');
  });

  it('uses defaults for missing or empty env variables', () => {
    process.env.SCENARII_TEST_EMPTY = '';
    try {
      assert.strictEqual(interpolateVars('{{env.SCENARII_TEST_MISSING:-localhost}}', {}), 'localhost');
      assert.strictEqual(interpolateVars('{{env.SCENARII_TEST_EMPTY:-localhost}}', {}), 'localhost');
    } finally {
      delete process.env.SCENARII_TEST_EMPTY;
    }
  });

  it('throws for missing env variables with step context', () => {
    delete process.env.SCENARII_TEST_MISSING;
    assert.throws(
      () => interpolateVars('{{env.SCENARII_TEST_MISSING}}', {}, 'Login'),
      /Unresolved environment variable "SCENARII_TEST_MISSING" in step "Login"/,
    );
  });
});

describe('resolveVariableDefinitions', () => {
  it('resolves env references and forward references between definitions', () => {
    process.env.SCENARII_TEST_TOKEN = 'abc';
    try {
      assert.deepStrictEqual(
        resolveVariableDefinitions({
          authorization: 'Bearer {{token}}',
          token: '{{env.SCENARII_TEST_TOKEN}}',
        }),
        { authorization: 'Bearer abc', token: 'abc' },
      );
    } finally {
      delete process.env.SCENARII_TEST_TOKEN;
    }
  });

  it('supports defaults inside definitions', () => {
    assert.deepStrictEqual(
      resolveVariableDefinitions({
        base_url: '{{env.SCENARII_TEST_MISSING:-https://example.com}}',
        health_url: '{{base_url}}/health',
      }),
      { base_url: 'https://example.com', health_url: 'https://example.com/health' },
    );
  });

  it('rejects circular references', () => {
    assert.throws(
      () => resolveVariableDefinitions({ a: '{{b}}', b: '{{a}}' }, 'scenario "loop" variables'),
      /Circular variable reference "a -> b -> a" in scenario "loop" variables/,
    );
  });
});

describe('mergeHeaders', () => {
  it('returns undefined when both inputs are empty', () => {
    assert.strictEqual(mergeHeaders(undefined, undefined), undefined);
    assert.strictEqual(mergeHeaders({}, {}), undefined);
  });

  it('merges shared headers', () => {
    assert.deepStrictEqual(
      mergeHeaders({ Authorization: 'Bearer a', Accept: 'application/json' }, { 'X-Trace': 't1' }),
      { Authorization: 'Bearer a', Accept: 'application/json', 'X-Trace': 't1' },
    );
  });

  it('lets step headers override shared headers regardless of casing', () => {
    assert.deepStrictEqual(
      mergeHeaders({ Authorization: 'Bearer a', 'X-Env': 'shared' }, { authorization: 'Bearer b' }),
      { 'X-Env': 'shared', authorization: 'Bearer b' },
    );
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
