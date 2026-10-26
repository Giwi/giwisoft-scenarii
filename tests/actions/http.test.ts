import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { checkExpectations, executeHttpStep } from '../../src/actions/http';
import { HttpStep } from '../../src/types';

function makeResponse(overrides: Partial<{ status: number; headers: Record<string, string>; body: string }> = {}) {
  return {
    status: overrides.status ?? 200,
    headers: overrides.headers ?? {},
    text: () => Promise.resolve(overrides.body ?? ''),
  };
}

describe('checkExpectations', () => {
  it('returns null when no expectations', () => {
    const step = { action: 'http.get', url: '/' } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse(), '', 0), null);
  });

  it('checks status', () => {
    const step = { action: 'http.get', url: '/', expect: { status: 200 } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse({ status: 200 }), '', 0), null);
    assert.match(checkExpectations(step, makeResponse({ status: 404 }), '', 0)!, /Expected status 200, got 404/);
  });

  it('checks status_in', () => {
    const step = { action: 'http.get', url: '/', expect: { status_in: [200, 301] } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse({ status: 301 }), '', 0), null);
    assert.match(checkExpectations(step, makeResponse({ status: 500 }), '', 0)!, /Expected status in/);
  });

  it('checks body_contains', () => {
    const step = { action: 'http.get', url: '/', expect: { body_contains: 'hello' } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse({ body: 'hello world' }), 'hello world', 0), null);
    assert.match(checkExpectations(step, makeResponse({ body: 'goodbye' }), 'goodbye', 0)!, /Body does not contain/);
  });

  it('checks body_matches', () => {
    const step = { action: 'http.get', url: '/', expect: { body_matches: 'hello.*world' } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse({ body: 'hello cruel world' }), 'hello cruel world', 0), null);
    assert.match(checkExpectations(step, makeResponse({ body: 'goodbye' }), 'goodbye', 0)!, /does not match regex/);
  });

  it('checks header_contains', () => {
    const step = { action: 'http.get', url: '/', expect: { header_contains: 'Content-Type: text/html' } } as HttpStep;
    const resp = makeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' } });
    assert.strictEqual(checkExpectations(step, resp, '', 0), null);

    const step404 = { action: 'http.get', url: '/', expect: { header_contains: 'X-Custom: missing' } } as HttpStep;
    assert.match(checkExpectations(step404, makeResponse({ headers: {} }), '', 0)!, /Header "X-Custom" does not contain/);
  });

  it('checks header_matches', () => {
    const step = { action: 'http.get', url: '/', expect: { header_matches: 'Content-Type: text/html.*' } } as HttpStep;
    const resp = makeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' } });
    assert.strictEqual(checkExpectations(step, resp, '', 0), null);

    const stepNoMatch = { action: 'http.get', url: '/', expect: { header_matches: 'X-Version: \\d+' } } as HttpStep;
    assert.match(checkExpectations(stepNoMatch, makeResponse({ headers: { 'x-version': 'abc' } }), '', 0)!, /does not match regex/);
  });

  it('checks json_path', () => {
    const step = { action: 'http.get', url: '/', expect: { json_path: '$.user.name' } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse({ body: '{"user":{"name":"Alice"}}' }), '{"user":{"name":"Alice"}}', 0), null);

    const stepMissing = { action: 'http.get', url: '/', expect: { json_path: '$.user.age' } } as HttpStep;
    assert.match(checkExpectations(stepMissing, makeResponse({ body: '{"user":{"name":"Alice"}}' }), '{"user":{"name":"Alice"}}', 0)!, /not found/);
  });

  it('checks json_path with json_value', () => {
    const step = { action: 'http.get', url: '/', expect: { json_path: '$.role', json_value: 'admin' } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse({ body: '{"role":"admin"}' }), '{"role":"admin"}', 0), null);

    const stepWrong = { action: 'http.get', url: '/', expect: { json_path: '$.role', json_value: 'user' } } as HttpStep;
    assert.match(checkExpectations(stepWrong, makeResponse({ body: '{"role":"admin"}' }), '{"role":"admin"}', 0)!, /expected.*got/);
  });

  it('returns error on invalid JSON body for json_path', () => {
    const step = { action: 'http.get', url: '/', expect: { json_path: '$.x' } } as HttpStep;
    assert.match(checkExpectations(step, makeResponse({ body: 'not-json' }), 'not-json', 0)!, /Failed to parse JSON/);
  });

  it('checks response_time_under', () => {
    const step = { action: 'http.get', url: '/', expect: { response_time_under: 100 } } as HttpStep;
    assert.strictEqual(checkExpectations(step, makeResponse(), '', 50), null);
    assert.match(checkExpectations(step, makeResponse(), '', 200)!, /exceeded limit/);
  });

  describe('body_schema', () => {
    function schemaStep(schema: Record<string, unknown>) {
      return { name: 's', action: 'http.post', url: '/', expect: { body_schema: schema } } as HttpStep;
    }

    it('passes on valid object', () => {
      assert.strictEqual(checkExpectations(schemaStep({ type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }), makeResponse({ body: '{"id":1}' }), '{"id":1}', 0), null);
    });

    it('rejects type mismatch', () => {
      assert.match(checkExpectations(schemaStep({ type: 'object', properties: { id: { type: 'string' } } }), makeResponse({ body: '{"id":1}' }), '{"id":1}', 0)!, /expected string/);
    });

    it('rejects missing required field', () => {
      assert.match(checkExpectations(schemaStep({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }), makeResponse({ body: '{}' }), '{}', 0)!, /missing required field/);
    });

    it('validates nested properties', () => {
      const nested = { type: 'object', properties: { user: { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] } } };
      assert.strictEqual(checkExpectations(schemaStep(nested), makeResponse({ body: '{"user":{"age":30}}' }), '{"user":{"age":30}}', 0), null);
      assert.match(checkExpectations(schemaStep(nested), makeResponse({ body: '{"user":{}}' }), '{"user":{}}', 0)!, /missing required field/);
    });

    it('validates array items', () => {
      assert.strictEqual(checkExpectations(schemaStep({ type: 'array', items: { type: 'number' } }), makeResponse({ body: '[1,2,3]' }), '[1,2,3]', 0), null);
      assert.match(checkExpectations(schemaStep({ type: 'array', items: { type: 'number' } }), makeResponse({ body: '[1,"x"]' }), '[1,"x"]', 0)!, /expected number/);
    });

    it('validates boolean type', () => {
      assert.strictEqual(checkExpectations(schemaStep({ type: 'object', properties: { active: { type: 'boolean' } } }), makeResponse({ body: '{"active":true}' }), '{"active":true}', 0), null);
      assert.match(checkExpectations(schemaStep({ type: 'object', properties: { active: { type: 'boolean' } } }), makeResponse({ body: '{"active":"yes"}' }), '{"active":"yes"}', 0)!, /expected boolean/);
    });

    it('validates null type', () => {
      assert.strictEqual(checkExpectations(schemaStep({ type: 'object', properties: { data: { type: 'null' } } }), makeResponse({ body: '{"data":null}' }), '{"data":null}', 0), null);
      assert.match(checkExpectations(schemaStep({ type: 'object', properties: { data: { type: 'null' } } }), makeResponse({ body: '{"data":1}' }), '{"data":1}', 0)!, /expected null/);
    });

    it('rejects unknown schema types instead of passing', () => {
      assert.match(checkExpectations(schemaStep({ type: 'objct' }), makeResponse({ body: '{}' }), '{}', 0)!, /unknown schema type "objct"/);
    });

    it('validates enum values', () => {
      const schema = { type: 'string', enum: ['admin', 'editor'] };
      assert.strictEqual(checkExpectations(schemaStep(schema), makeResponse({ body: '"admin"' }), '"admin"', 0), null);
      assert.match(
        checkExpectations(schemaStep(schema), makeResponse({ body: '"guest"' }), '"guest"', 0)!,
        /expected one of "admin", "editor", got "guest"/,
      );
    });

    it('validates string patterns', () => {
      const schema = { type: 'string', pattern: '^[a-z]+$' };
      assert.strictEqual(checkExpectations(schemaStep(schema), makeResponse({ body: '"abc"' }), '"abc"', 0), null);
      assert.match(
        checkExpectations(schemaStep(schema), makeResponse({ body: '"abc1"' }), '"abc1"', 0)!,
        /does not match pattern/,
      );
      assert.match(
        checkExpectations(schemaStep({ type: 'string', pattern: '[' }), makeResponse({ body: '"abc"' }), '"abc"', 0)!,
        /invalid pattern/,
      );
    });

    it('validates numeric min and max', () => {
      const schema = { type: 'number', min: 1, max: 10 };
      assert.strictEqual(checkExpectations(schemaStep(schema), makeResponse({ body: '5' }), '5', 0), null);
      assert.match(checkExpectations(schemaStep(schema), makeResponse({ body: '0' }), '0', 0)!, /expected at least 1/);
      assert.match(checkExpectations(schemaStep(schema), makeResponse({ body: '11' }), '11', 0)!, /expected at most 10/);
    });

    it('allows null only when nullable is true', () => {
      const nullable = { type: 'string', nullable: true };
      assert.strictEqual(checkExpectations(schemaStep(nullable), makeResponse({ body: 'null' }), 'null', 0), null);
      assert.match(
        checkExpectations(schemaStep({ type: 'string' }), makeResponse({ body: 'null' }), 'null', 0)!,
        /expected string, got null/,
      );
    });

    it('returns error on non-JSON body', () => {
      assert.match(checkExpectations(schemaStep({ type: 'object' }), makeResponse({ body: 'not-json' }), 'not-json', 0)!, /Failed to parse JSON/);
    });
  });
});

describe('executeHttpStep request body', () => {
  it('interpolates variables in JSON bodies and sets Content-Type', async () => {
    let captured: { headers?: Record<string, string>; body?: string } = {};
    const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
      captured = { headers: init.headers, body: init.body };
      return new Response('{"ok":true}', { status: 200 });
    });
    try {
      const step = {
        name: 'Login',
        action: 'http.post',
        url: '/api/login',
        headers: { 'X-Trace': '{{trace}}' },
        body: { token: '{{token}}', nested: { list: ['{{token}}', 5] } },
      } as HttpStep;
      const metrics = await executeHttpStep(step, 'https://example.com', { token: 'abc', trace: 't1' });

      assert.strictEqual(metrics.success, true);
      assert.strictEqual(captured.headers?.['Content-Type'], 'application/json');
      assert.strictEqual(captured.headers?.['X-Trace'], 't1');
      assert.deepStrictEqual(JSON.parse(captured.body!), {
        token: 'abc',
        nested: { list: ['abc', 5] },
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('keeps an explicit Content-Type header', async () => {
    let captured: { headers?: Record<string, string> } = {};
    const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
      captured = { headers: init.headers };
      return new Response('{}', { status: 200 });
    });
    try {
      const step = {
        name: 'Custom',
        action: 'http.post',
        url: '/api',
        headers: { 'content-type': 'application/vnd.api+json' },
        body: { value: '{{value}}' },
      } as HttpStep;
      await executeHttpStep(step, 'https://example.com', { value: 'v' });

      assert.strictEqual(captured.headers?.['Content-Type'], undefined);
      assert.strictEqual(captured.headers?.['content-type'], 'application/vnd.api+json');
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('interpolates variables in string bodies without adding a header', async () => {
    let captured: { headers?: Record<string, string>; body?: string } = {};
    const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
      captured = { headers: init.headers, body: init.body };
      return new Response('ok', { status: 200 });
    });
    try {
      const step = {
        name: 'Form',
        action: 'http.post',
        url: '/api',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token={{token}}',
      } as HttpStep;
      await executeHttpStep(step, 'https://example.com', { token: 'abc' });

      assert.strictEqual(captured.body, 'token=abc');
      assert.strictEqual(captured.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('includes body download time in response_time_ms', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => ({
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 60)),
    }));
    try {
      const step = {
        name: 'Slow body',
        action: 'http.get',
        url: '/slow',
        expect: { response_time_under: 20 },
      } as HttpStep;
      const metrics = await executeHttpStep(step, 'https://example.com', {});

      assert.strictEqual(metrics.success, false);
      assert.match(metrics.error!, /Response time .* exceeded limit of 20ms/);
      assert.ok(metrics.response_time_ms >= 40, `expected at least 40ms, got ${metrics.response_time_ms}`);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
