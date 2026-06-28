import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseScenario, serializeScenario, resolveIncludes } from '../src/parser';
import { Scenario, HttpStep, IncludeStep } from '../src/types';

describe('parseScenario', () => {
  it('parses a minimal valid scenario', () => {
    const yaml = `
name: test
steps:
  - action: http.get
    url: /
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.name, 'test');
    assert.strictEqual(s.steps.length, 1);
    assert.strictEqual((s.steps[0] as HttpStep).action, 'http.get');
  });

  it('throws when name is missing', () => {
    assert.throws(() => parseScenario('steps: []'), /"name" field/);
  });

  it('throws when steps is missing', () => {
    assert.throws(() => parseScenario('name: x'), /"steps" array/);
  });

  it('throws when steps is not an array', () => {
    assert.throws(() => parseScenario('name: x\nsteps: foo'), /"steps" array/);
  });

  it('throws on unknown action type', () => {
    assert.throws(() => parseScenario(`
name: x
steps:
  - action: foo.bar
    url: /
`), /Unknown action type/);
  });

  it('parses optional fields', () => {
    const yaml = `
name: full
description: desc
schedule: "*/5 * * * *"
base_url: https://example.com
tags: [prod, critical]
timeout: 30000
steps:
  - action: http.get
    url: /
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.description, 'desc');
    assert.strictEqual(s.schedule, '*/5 * * * *');
    assert.strictEqual(s.base_url, 'https://example.com');
    assert.deepStrictEqual(s.tags, ['prod', 'critical']);
    assert.strictEqual(s.timeout, 30000);
  });

  it('assigns default step names', () => {
    const yaml = `
name: test
steps:
  - action: http.get
    url: /
  - action: http.post
    url: /api
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.steps[0].name, 'step_0');
    assert.strictEqual(s.steps[1].name, 'step_1');
  });

  it('parses include step', () => {
    const yaml = `
name: parent
steps:
  - include: login
  - name: step2
    action: http.get
    url: /
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.steps.length, 2);
    assert.strictEqual((s.steps[0] as IncludeStep).include, 'login');
    assert.strictEqual((s.steps[1] as HttpStep).action, 'http.get');
  });

  it('parses group field', () => {
    const yaml = `
name: grouped
group: api
steps:
  - action: http.get
    url: /
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.group, 'api');
  });

  it('parses time_windows', () => {
    const yaml = `
name: windowed
time_windows:
  - start: "09:00"
    end: "17:00"
steps:
  - action: http.get
    url: /
`;
    const s = parseScenario(yaml);
    assert.ok(s.time_windows);
    assert.strictEqual(s.time_windows!.length, 1);
    assert.strictEqual(s.time_windows![0].start, '09:00');
    assert.strictEqual(s.time_windows![0].end, '17:00');
  });

  it('parses browser step variables', () => {
    const yaml = `
name: eval-vars
steps:
  - name: Eval
    action: browser.evaluate
    script: "{ version: '1.0' }"
    variables:
      app_ver: $.version
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.steps.length, 1);
    const step = s.steps[0] as import('../src/types').BrowserStep;
    assert.strictEqual(step.script, "{ version: '1.0' }");
    assert.deepStrictEqual(step.variables, { app_ver: '$.version' });
  });

  it('parses body_schema in expect', () => {
    const yaml = `
name: schema-test
steps:
  - name: Check
    action: http.post
    url: /api
    expect:
      status: 200
      body_schema:
        type: object
        properties:
          id:
            type: number
          name:
            type: string
        required: [id]
`;
    const s = parseScenario(yaml);
    const step = s.steps[0] as HttpStep;
    assert.ok(step.expect);
    assert.ok(step.expect!.body_schema);
    assert.strictEqual((step.expect!.body_schema as any).type, 'object');
  });

  it('parses browser steps with their fields', () => {
    const yaml = `
name: browser-test
steps:
  - name: Nav
    action: browser.navigate
    url: /page
  - name: Fill
    action: browser.fill
    selector: "#input"
    value: hello
  - name: Wait
    action: browser.wait_for
    selector: ".result"
    timeout: 5000
    expect:
      has_text: Success
`;
    const s = parseScenario(yaml);
    assert.strictEqual(s.steps.length, 3);
    const fill = s.steps[1];
    if ('selector' in fill) {
      assert.strictEqual(fill.selector, '#input');
      assert.strictEqual(fill.value, 'hello');
    } else {
      assert.fail('expected browser step');
    }
  });
});

describe('serializeScenario', () => {
  it('round-trips a full scenario with all fields', () => {
    const scenario: Scenario = {
      name: 'roundtrip',
      description: 'test',
      base_url: 'https://example.com',
      schedule: '*/10 * * * *',
      tags: ['a', 'b'],
      timeout: 60000,
      group: 'api',
      ignoreHTTPSErrors: true,
      time_windows: [{ start: '09:00', end: '17:00' }],
      steps: [
        {
          name: 'Get',
          action: 'http.get',
          url: '/api',
          headers: { Authorization: 'Bearer {{token}}' },
          expect: { status: 200, body_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
          variables: { token: '$.data.token' },
        },
        { include: 'health', name: 'HealthInc' },
      ],
    };
    const yaml = serializeScenario(scenario);
    const parsed = parseScenario(yaml);
    assert.strictEqual(parsed.name, 'roundtrip');
    assert.strictEqual(parsed.steps.length, 2);
    assert.strictEqual((parsed.steps[0] as HttpStep).action, 'http.get');
    assert.strictEqual((parsed.steps[1] as IncludeStep).include, 'health');
    assert.strictEqual((parsed.steps[1] as IncludeStep).name, 'HealthInc');
    assert.strictEqual(parsed.group, 'api');
    assert.strictEqual(parsed.ignoreHTTPSErrors, true);
    assert.ok(parsed.time_windows);
    assert.strictEqual(parsed.time_windows![0].start, '09:00');
    assert.strictEqual(parsed.time_windows![0].end, '17:00');
  });

  it('handles browser steps with condition', () => {
    const scenario: Scenario = {
      name: 'conditional',
      steps: [
        {
          name: 'Login',
          action: 'http.post',
          url: '/login',
          expect: { status: 200 },
        },
        {
          name: 'Dashboard',
          action: 'http.get',
          url: '/dashboard',
          condition: { if_step: 'Login', if_success: true },
        },
      ],
    };
    const yaml = serializeScenario(scenario);
    const parsed = parseScenario(yaml);
    assert.strictEqual((parsed.steps[1] as HttpStep).action, 'http.get');
  });
});
