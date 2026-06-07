import cron from 'node-cron';
import { Scenario } from './types';
import { runScenario, RunOptions } from './runner';
import { sendDailyReport } from './report';

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
    console.log(`No schedule for scenario "${scenario.name}", running once...`);
    runScenario(scenario, options);
    return null;
  }

  if (!cron.validate(scenario.schedule)) {
    console.error(`Invalid cron expression "${scenario.schedule}" for scenario "${scenario.name}"`);
    return null;
  }

  console.log(`Scheduling "${scenario.name}" with cron: ${scenario.schedule}`);

  const task = cron.schedule(scenario.schedule, async () => {
    console.log(`\n[${new Date().toISOString()}] Running scenario: ${scenario.name}`);
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
