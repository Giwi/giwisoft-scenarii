import { StepMetrics, ScenarioMetrics, Reporter } from './types';
import pc from 'picocolors';

// Creates a fresh StepMetrics object with the given name and action.
export function createStepMetrics(step_name: string, action: string): StepMetrics {
  return {
    step_name,
    action,
    success: false,
    response_time_ms: 0,
    timestamp: new Date(),
  };
}

// Finalises a StepMetrics by merging in partial overrides.
export function completeStepMetrics(
  metrics: StepMetrics,
  overrides: Partial<StepMetrics>
): StepMetrics {
  return { ...metrics, ...overrides, timestamp: new Date() };
}

// Creates a fresh ScenarioMetrics object initialised as passing.
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

// Pretty-prints scenario metrics to the console with colored PASS/FAIL output.
export const consoleReporter: Reporter = (metrics: ScenarioMetrics): void => {
  const status = metrics.success ? pc.green('✓ PASS') : pc.red('✗ FAIL');
  console.log(`\n${status} ${metrics.scenario_name}`);
  console.log(`  Duration: ${metrics.duration_ms}ms`);
  console.log(`  Steps: ${metrics.steps.length} total`);

  for (const step of metrics.steps) {
    const icon = step.success ? pc.green('✓') : pc.red('✗');
    const time = pc.gray(`(${step.response_time_ms}ms)`);
    const err = step.error ? pc.red(` - ${step.error}`) : '';
    console.log(`  ${icon} ${step.step_name} ${time}${err}`);
  }
};

// Outputs scenario metrics as a JSON blob.
export const jsonReporter: Reporter = (metrics: ScenarioMetrics): void => {
  console.log(JSON.stringify(metrics, null, 2));
};
