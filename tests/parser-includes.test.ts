import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveIncludes } from '../src/parser';
import { Scenario } from '../src/types';

let scenariosDir: string;

before(() => {
  scenariosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarii-include-'));
  fs.writeFileSync(path.join(scenariosDir, 'login.yml'), `name: login
steps:
  - name: LoginReq
    action: http.post
    url: /api/login
    expect:
      status: 200
`);
  fs.writeFileSync(path.join(scenariosDir, 'health.yml'), `name: health
steps:
  - name: Ping
    action: http.get
    url: /ping
`);
  fs.writeFileSync(path.join(scenariosDir, 'nested.yml'), `name: nested
steps:
  - include: health
`);
  fs.writeFileSync(path.join(scenariosDir, 'circular-a.yml'), `name: circular-a
steps:
  - include: circular-b
`);
  fs.writeFileSync(path.join(scenariosDir, 'circular-b.yml'), `name: circular-b
steps:
  - include: circular-a
`);
});

after(() => {
  fs.rmSync(scenariosDir, { recursive: true, force: true });
});

describe('resolveIncludes', () => {
  it('flattens include steps from referenced scenarios', () => {
    const scenario: Scenario = {
      name: 'parent',
      steps: [{ include: 'login' }, { name: 'Extra', action: 'http.get', url: '/' }],
    };
    const steps = resolveIncludes(scenario, scenariosDir);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual((steps[0] as any).name, 'LoginReq');
    assert.strictEqual((steps[1] as any).name, 'Extra');
  });

  it('throws on circular includes', () => {
    const scenario: Scenario = {
      name: 'circular-a',
      steps: [{ include: 'circular-b' }],
    };
    assert.throws(() => resolveIncludes(scenario, scenariosDir), /Circular include detected/);
  });

  it('supports nested includes', () => {
    const scenario: Scenario = {
      name: 'nested',
      steps: [{ include: 'nested' }],
    };
    const steps = resolveIncludes(scenario, scenariosDir);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual((steps[0] as any).name, 'Ping');
  });

  it('throws when included scenario file is not found', () => {
    const scenario: Scenario = {
      name: 'missing',
      steps: [{ include: 'nonexistent' }],
    };
    assert.throws(() => resolveIncludes(scenario, scenariosDir), /not found/);
  });

  it('prefixes step names with include name', () => {
    const scenario: Scenario = {
      name: 'with-prefix',
      steps: [{ include: 'health', name: 'HealthCheck' }],
    };
    const steps = resolveIncludes(scenario, scenariosDir);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual((steps[0] as any).name, 'HealthCheck: Ping');
  });
});
