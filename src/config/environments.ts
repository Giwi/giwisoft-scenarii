// Environment profiles let the same scenario target staging or production. The
// selected profile is applied by the runner, after scenario parsing, so scheduled
// runs, API triggers, and CLI runs all behave identically.

import { Scenario } from '../types';
import { getSettings, EnvironmentConfig } from './settings';

export function getEnvironment(name: string): EnvironmentConfig {
  const environments = getSettings().environments;
  const environment = environments?.[name];
  if (!environment) {
    const available = Object.keys(environments ?? {}).sort();
    throw new Error(
      `Unknown environment "${name}"${available.length ? ` (available: ${available.join(', ')})` : ''}`,
    );
  }
  return environment;
}

// Returns a copy of the scenario with the profile's base_url, headers, variables,
// and secrets merged in. Secrets and variables feed the usual {{NAME}} resolution,
// so values can themselves reference {{env.SECRET}}.
export function applyEnvironment(scenario: Scenario, name: string): Scenario {
  const environment = getEnvironment(name);
  return {
    ...scenario,
    base_url: environment.base_url ?? scenario.base_url,
    headers: {
      ...(scenario.headers ?? {}),
      ...(environment.headers ?? {}),
    },
    variables: {
      ...(scenario.variables ?? {}),
      ...(environment.variables ?? {}),
      ...(environment.secrets ?? {}),
    },
  };
}
