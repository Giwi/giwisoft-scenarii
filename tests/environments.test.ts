import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { loadSettings } from '../src/config/settings';
import { applyEnvironment, getEnvironment } from '../src/config/environments';
import { Scenario } from '../src/types';

before(() => {
  loadSettings().environments = {
    staging: {
      base_url: 'https://staging.example.com',
      headers: { 'X-Env': 'staging', Authorization: 'Bearer {{STAGING_TOKEN}}' },
      variables: { REGION: 'eu' },
      secrets: { STAGING_TOKEN: '{{env.STAGING_TOKEN}}' },
    },
    production: {
      base_url: 'https://example.com',
    },
  };
});

const scenario: Scenario = {
  name: 'smoke',
  base_url: 'https://localhost:3000',
  headers: { 'X-Scenario': 'smoke', 'X-Env': 'local' },
  variables: { REGION: 'us' },
  steps: [{ name: 'Home', action: 'http.get', url: '/' }],
};

describe('environment profiles', () => {
  it('overrides base_url, merges headers, variables, and secrets', () => {
    const resolved = applyEnvironment(scenario, 'staging');
    assert.strictEqual(resolved.base_url, 'https://staging.example.com');
    assert.strictEqual(resolved.headers?.['X-Env'], 'staging');
    assert.strictEqual(resolved.headers?.['X-Scenario'], 'smoke');
    assert.strictEqual(resolved.variables?.REGION, 'eu');
    assert.strictEqual(resolved.variables?.STAGING_TOKEN, '{{env.STAGING_TOKEN}}');
  });

  it('does not mutate the source scenario', () => {
    applyEnvironment(scenario, 'staging');
    assert.strictEqual(scenario.base_url, 'https://localhost:3000');
    assert.strictEqual(scenario.variables?.REGION, 'us');
    assert.strictEqual(scenario.headers?.['X-Env'], 'local');
  });

  it('keeps scenario base_url when the profile omits it', () => {
    const resolved = applyEnvironment(scenario, 'production');
    assert.strictEqual(resolved.base_url, 'https://example.com');
    assert.strictEqual(resolved.variables?.REGION, 'us');
  });

  it('reports unknown profiles with the available names', () => {
    assert.throws(() => getEnvironment('nope'), /Unknown environment "nope".*production, staging/);
  });
});
