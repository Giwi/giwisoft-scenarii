// Pure run comparison used by GET /api/runs/:id/diff/:baseId. Works entirely on the
// existing run history shape; no schema or storage changes are required.

import { ScenarioMetrics, StepMetrics } from '../types';

export interface StepDiffSide {
  success: boolean;
  status_code?: number;
  duration_ms: number;
  error?: string;
}

export interface StepDiff {
  step_name: string;
  action: string;
  base?: StepDiffSide;
  target?: StepDiffSide;
  status_changed: boolean;
  duration_delta_ms?: number;
  duration_delta_pct?: number;
  error_changed: boolean;
}

export interface RunDiff {
  scenario_name: string;
  base: {
    run_id?: number;
    started_at: string;
    finished_at: string;
    success: boolean;
    duration_ms: number;
  };
  target: {
    run_id?: number;
    started_at: string;
    finished_at: string;
    success: boolean;
    duration_ms: number;
  };
  status_changed: boolean;
  duration_delta_ms: number;
  duration_delta_pct: number;
  steps: StepDiff[];
}

function side(step: StepMetrics | undefined): StepDiffSide | undefined {
  if (!step) return undefined;
  return {
    success: step.success,
    status_code: step.status_code,
    duration_ms: step.response_time_ms,
    error: step.error,
  };
}

function normalizedError(step: StepMetrics | undefined): string {
  return step?.error ?? '';
}

export function diffRuns(base: ScenarioMetrics, target: ScenarioMetrics): RunDiff {
  const baseMap = new Map<string, StepMetrics>();
  for (const step of base.steps) baseMap.set(step.step_name, step);
  const targetMap = new Map<string, StepMetrics>();
  for (const step of target.steps) targetMap.set(step.step_name, step);

  const names: string[] = [];
  for (const step of base.steps) if (!names.includes(step.step_name)) names.push(step.step_name);
  for (const step of target.steps) if (!names.includes(step.step_name)) names.push(step.step_name);

  const steps: StepDiff[] = names.map(name => {
    const before = baseMap.get(name);
    const after = targetMap.get(name);
    const beforeSide = side(before);
    const afterSide = side(after);
    let delta: number | undefined;
    let deltaPct: number | undefined;
    if (beforeSide && afterSide) {
      delta = afterSide.duration_ms - beforeSide.duration_ms;
      deltaPct = beforeSide.duration_ms === 0
        ? (afterSide.duration_ms === 0 ? 0 : 100)
        : (delta / beforeSide.duration_ms) * 100;
    }
    return {
      step_name: name,
      action: after?.action ?? before?.action ?? '',
      base: beforeSide,
      target: afterSide,
      status_changed: !!beforeSide && !!afterSide && beforeSide.success !== afterSide.success,
      duration_delta_ms: delta,
      duration_delta_pct: deltaPct,
      error_changed: normalizedError(before) !== normalizedError(after),
    };
  });

  const durationDelta = target.duration_ms - base.duration_ms;
  return {
    scenario_name: target.scenario_name,
    base: {
      run_id: base.run_id,
      started_at: base.started_at.toISOString(),
      finished_at: base.finished_at.toISOString(),
      success: base.success,
      duration_ms: base.duration_ms,
    },
    target: {
      run_id: target.run_id,
      started_at: target.started_at.toISOString(),
      finished_at: target.finished_at.toISOString(),
      success: target.success,
      duration_ms: target.duration_ms,
    },
    status_changed: base.success !== target.success,
    duration_delta_ms: durationDelta,
    duration_delta_pct: base.duration_ms === 0
      ? (target.duration_ms === 0 ? 0 : 100)
      : (durationDelta / base.duration_ms) * 100,
    steps,
  };
}
