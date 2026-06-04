import { StepMetrics, ScenarioMetrics, Reporter } from './types';

export function createStepMetrics(step_name: string, action: string): StepMetrics {
  return {
    step_name,
    action,
    success: false,
    response_time_ms: 0,
    timestamp: new Date(),
  };
}

export function completeStepMetrics(
  metrics: StepMetrics,
  overrides: Partial<StepMetrics>
): StepMetrics {
  return { ...metrics, ...overrides, timestamp: new Date() };
}

export function createScenarioMetrics(scenario_name: string): ScenarioMetrics {
  return {
    scenario_name,
    started_at: new Date(),
    finished_at: new Date(),
    duration_ms: 0,
    success: true,
    steps: [],
  };
}

export const consoleReporter: Reporter = (metrics: ScenarioMetrics): void => {
  // Dynamic import for CJS compatibility
  const chalk = require('chalk');
  const status = metrics.success ? chalk.green('✓ PASS') : chalk.red('✗ FAIL');
  console.log(`\n${status} ${metrics.scenario_name}`);
  console.log(`  Duration: ${metrics.duration_ms}ms`);
  console.log(`  Steps: ${metrics.steps.length} total`);

  for (const step of metrics.steps) {
    const icon = step.success ? chalk.green('✓') : chalk.red('✗');
    const time = chalk.gray(`(${step.response_time_ms}ms)`);
    const err = step.error ? chalk.red(` - ${step.error}`) : '';
    console.log(`  ${icon} ${step.step_name} ${time}${err}`);
  }
};

export const jsonReporter: Reporter = (metrics: ScenarioMetrics): void => {
  console.log(JSON.stringify(metrics, null, 2));
};
