import cron, { type ScheduledTask as CronScheduledTask } from 'node-cron';
import fs from 'fs';
import path from 'path';
import { Scenario, AlertConfig, TimeWindow } from './types';
import { runScenario, RunOptions } from './runner';
import { sendDailyReport } from './report';
import { upsertScenarioTags, getPreviousRunSuccess, getLastRunSuccess } from './storage';
import { getSettings } from './settings';
import { loadScenarioFile } from './parser';
import logger from './logger';
import { DEFAULT_ALERT_CONSECUTIVE_FAILURES } from './constants';

interface ScheduledTask {
  scenario: Scenario;
  task: CronScheduledTask;
  options: RunOptions;
  paused: boolean;
  filePath?: string;
  mtimeMs?: number;
}

const scheduledTasks: ScheduledTask[] = [];

// Checks if a given Date falls within a time window (HH:mm format).
function isInTimeWindow(dt: Date, window: TimeWindow): boolean {
  const minutes = dt.getHours() * 60 + dt.getMinutes();
  const startParts = window.start.split(':').map(Number);
  const endParts = window.end.split(':').map(Number);
  const startMinutes = startParts[0] * 60 + (startParts[1] || 0);
  const endMinutes = endParts[0] * 60 + (endParts[1] || 0);
  if (startMinutes <= endMinutes) {
    return minutes >= startMinutes && minutes <= endMinutes;
  }
  // Wraps past midnight (e.g. 22:00 - 06:00)
  return minutes >= startMinutes || minutes <= endMinutes;
}

// Schedules a scenario based on its cron expression, or runs it immediately if no schedule is set.
// Returns the cron task, or null when run-once.
export function scheduleScenario(
  scenario: Scenario,
  options: RunOptions = {},
  filePath?: string,
  mtimeMs?: number
): CronScheduledTask | null {
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

    // If the scenario has time windows, check if current time falls within one
    if (scenario.time_windows && scenario.time_windows.length > 0) {
      const now = new Date();
      const inWindow = scenario.time_windows.some(w => isInTimeWindow(now, w));
      if (!inWindow) {
        logger.info({ scenario: scenario.name, time_windows: scenario.time_windows }, 'Outside time window, skipping run');
        return;
      }
    }

    // If the scenario depends on another, check that dependency's last run succeeded
    if (scenario.depends_on) {
      const depOk = getLastRunSuccess(scenario.depends_on);
      if (depOk === false) {
        logger.warn({ scenario: scenario.name, depends_on: scenario.depends_on }, 'Dependency failed, skipping run');
        return;
      }
      logger.info({ scenario: scenario.name, depends_on: scenario.depends_on, dep_status: depOk }, 'Dependency check passed');
    }

    logger.info({ scenario: scenario.name }, 'Running scenario');
    const metrics = await runScenario(scenario, options);

    // Check for consecutive failures and emit a warning if threshold is exceeded
    const alertConfig: AlertConfig = scenario.alert || {};
    const threshold = alertConfig.consecutive_failures ?? DEFAULT_ALERT_CONSECUTIVE_FAILURES;
    if (!metrics.success && threshold > 0) {
      let consecutive = 1;
      for (let i = 0; i < threshold; i++) {
        const prev = getPreviousRunSuccess(scenario.name);
        if (prev === false) consecutive++;
        else break;
      }
      if (consecutive >= threshold) {
        logger.warn({ scenario: scenario.name, consecutive_failures: consecutive, threshold }, 'Alert: consecutive failures threshold reached');
      }
    }
  });

  if (scenario.tags && scenario.tags.length > 0) {
    try {
      upsertScenarioTags(scenario.name, scenario.tags);
    } catch (err: unknown) {
      logger.warn({ scenario: scenario.name, err: err instanceof Error ? err.message : err }, 'Failed to store scenario tags');
    }
  }

  scheduledTasks.push({ scenario, task, options, paused: false, filePath, mtimeMs });
  return task;
}

// Pauses a scheduled scenario so it won't run on the next cron tick.
export function pauseScenario(name: string): boolean {
  const entry = scheduledTasks.find(st => st.scenario.name === name);
  if (!entry) return false;
  entry.paused = true;
  logger.info({ scenario: name }, 'Scenario paused');
  return true;
}

// Resumes a previously paused scenario.
export function resumeScenario(name: string): boolean {
  const entry = scheduledTasks.find(st => st.scenario.name === name);
  if (!entry) return false;
  entry.paused = false;
  logger.info({ scenario: name }, 'Scenario resumed');
  return true;
}

// Returns true if the named scenario is currently paused.
export function isPaused(name: string): boolean {
  return scheduledTasks.some(st => st.scenario.name === name && st.paused);
}

// Returns true if the named scenario has been scheduled.
export function isScheduled(name: string): boolean {
  return scheduledTasks.some(st => st.scenario.name === name);
}

// Stops and removes a scheduled scenario by name. Returns true if found.
export function unscheduleScenario(name: string): boolean {
  const idx = scheduledTasks.findIndex(st => st.scenario.name === name);
  if (idx === -1) return false;
  const entry = scheduledTasks[idx];
  entry.task.stop();
  scheduledTasks.splice(idx, 1);
  logger.info({ scenario: name }, 'Scenario unscheduled');
  return true;
}

// Stops all scheduled tasks and clears the task list.
export function stopAll(): void {
  for (const st of scheduledTasks) {
    st.task.stop();
  }
  scheduledTasks.length = 0;
}

// Returns the names of all currently scheduled scenarios.
export function listScheduled(): string[] {
  return scheduledTasks.map((st) => st.scenario.name);
}

// Reconciles the scenarios directory with the current set of scheduled tasks.
// New/updated files get scheduled; removed files get unscheduled.
export function rescanScenarios(scenariosDir: string, options: RunOptions): void {
  let files: string[];
  try {
    files = fs.readdirSync(scenariosDir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map(f => path.join(scenariosDir, f));
  } catch {
    logger.error(`Scenarios directory not found: ${scenariosDir}`);
    return;
  }

  // Collect file info keyed by basename
  const fileMap = new Map<string, { filePath: string; mtimeMs: number }>();
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      fileMap.set(path.basename(file), { filePath: file, mtimeMs: stat.mtimeMs });
    } catch { /* race: file disappeared between readdir and stat */ }
  }

  // Unschedule scenarios whose file no longer exists on disk
  for (const entry of scheduledTasks) {
    if (entry.filePath) {
      const basename = path.basename(entry.filePath);
      if (!fileMap.has(basename)) {
        logger.info({ scenario: entry.scenario.name, file: entry.filePath }, 'Scenario file removed, unscheduling');
        unscheduleScenario(entry.scenario.name);
      }
    }
  }

  // Schedule new or updated scenarios
  for (const [, info] of fileMap) {
    try {
      const scenario = loadScenarioFile(info.filePath);
      const existing = scheduledTasks.find(st => st.scenario.name === scenario.name);
      if (existing) {
        if (existing.mtimeMs !== info.mtimeMs) {
          logger.info({ scenario: scenario.name, file: info.filePath }, 'Scenario file changed, rescheduling');
          unscheduleScenario(scenario.name);
          if (scenario.schedule) {
            scheduleScenario(scenario, options, info.filePath, info.mtimeMs);
          }
        }
      } else if (scenario.schedule) {
        logger.info({ scenario: scenario.name, file: info.filePath }, 'New scenario found, scheduling');
        scheduleScenario(scenario, options, info.filePath, info.mtimeMs);
      }
    } catch (err: unknown) {
      logger.error({ file: info.filePath, err: err instanceof Error ? err.message : err }, 'Failed to load scenario during rescan');
    }
  }
}

// Periodically rescans the scenarios directory to pick up new/removed files.
export function watchScenarios(scenariosDir: string, options: RunOptions, intervalMs: number = 5000): void {
  setInterval(() => {
    rescanScenarios(scenariosDir, options);
  }, intervalMs);
}

// Schedules the daily email report on the given cron expression.
export function scheduleReport(cronExpression: string): CronScheduledTask {
  const task = cron.schedule(cronExpression, async () => {
    await sendDailyReport();
  });
  return task;
}
