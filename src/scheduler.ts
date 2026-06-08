import cron from 'node-cron';
import { Scenario } from './types';
import { runScenario, RunOptions } from './runner';
import { sendDailyReport } from './report';
import { upsertScenarioTags } from './storage';
import logger from './logger';

interface ScheduledTask {
  scenario: Scenario;
  task: cron.ScheduledTask;
  options: RunOptions;
  paused: boolean;
}

const scheduledTasks: ScheduledTask[] = [];

export function scheduleScenario(
  scenario: Scenario,
  options: RunOptions = {}
): cron.ScheduledTask | null {
  if (!scenario.schedule) {
    logger.info({ scenario: scenario.name }, 'No schedule, running once');
    runScenario(scenario, options);
    return null;
  }

  if (!cron.validate(scenario.schedule)) {
    logger.error({ scenario: scenario.name, schedule: scenario.schedule }, 'Invalid cron expression');
    return null;
  }

  logger.info({ scenario: scenario.name, schedule: scenario.schedule }, 'Scheduling scenario');

  const task = cron.schedule(scenario.schedule, async () => {
    const entry = scheduledTasks.find(st => st.scenario.name === scenario.name);
    if (entry?.paused) {
      logger.info({ scenario: scenario.name }, 'Scenario is paused, skipping run');
      return;
    }
    logger.info({ scenario: scenario.name }, 'Running scenario');
    await runScenario(scenario, options);
  });

  if (scenario.tags && scenario.tags.length > 0) {
    try {
      upsertScenarioTags(scenario.name, scenario.tags);
    } catch (err: unknown) {
      logger.warn({ scenario: scenario.name, err: err instanceof Error ? err.message : err }, 'Failed to store scenario tags');
    }
  }

  scheduledTasks.push({ scenario, task, options, paused: false });
  return task;
}

export function pauseScenario(name: string): boolean {
  const entry = scheduledTasks.find(st => st.scenario.name === name);
  if (!entry) return false;
  entry.paused = true;
  logger.info({ scenario: name }, 'Scenario paused');
  return true;
}

export function resumeScenario(name: string): boolean {
  const entry = scheduledTasks.find(st => st.scenario.name === name);
  if (!entry) return false;
  entry.paused = false;
  logger.info({ scenario: name }, 'Scenario resumed');
  return true;
}

export function isPaused(name: string): boolean {
  return scheduledTasks.some(st => st.scenario.name === name && st.paused);
}

export function isScheduled(name: string): boolean {
  return scheduledTasks.some(st => st.scenario.name === name);
}

export function stopAll(): void {
  for (const st of scheduledTasks) {
    st.task.stop();
  }
  scheduledTasks.length = 0;
}

export function listScheduled(): string[] {
  return scheduledTasks.map((st) => st.scenario.name);
}

export function scheduleReport(cronExpression: string): cron.ScheduledTask {
  const task = cron.schedule(cronExpression, async () => {
    await sendDailyReport();
  });
  return task;
}
