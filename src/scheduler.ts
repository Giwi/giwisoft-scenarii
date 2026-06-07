import cron from 'node-cron';
import { Scenario } from './types';
import { runScenario, RunOptions } from './runner';
import { sendDailyReport } from './report';
import logger from './logger';

interface ScheduledTask {
  scenario: Scenario;
  task: cron.ScheduledTask;
  options: RunOptions;
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
    logger.info({ scenario: scenario.name }, 'Running scenario');
    await runScenario(scenario, options);
  });

  scheduledTasks.push({ scenario, task, options });
  return task;
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
