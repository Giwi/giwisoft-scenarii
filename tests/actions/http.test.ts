import { describe, it } from 'node:test';
import assert from 'node:assert';
import { checkExpectations } from '../../src/actions/http';
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

    it('returns error on non-JSON body', () => {
      assert.match(checkExpectations(schemaStep({ type: 'object' }), makeResponse({ body: 'not-json' }), 'not-json', 0)!, /Failed to parse JSON/);
    });
  });
});
