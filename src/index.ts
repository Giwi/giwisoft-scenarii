#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { loadScenarioFile } from './parser';
import { runScenario, RunOptions } from './runner';
import { scheduleScenario, stopAll, listScheduled, scheduleReport } from './scheduler';
import { initStorage, closeStorage, isStorageReady } from './storage';
import { loadSettings, watchSettings } from './settings';
import { createServer, closeLightpanda } from './server';
import logger from './logger';
import { DAILY_REPORT_CRON } from './constants';

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason instanceof Error ? reason.message : reason }, 'Unhandled rejection');
});

function shutdown(server?: http.Server): void {
  logger.info('Shutting down...');
  stopAll();
  closeLightpanda();
  if (server) {
    server.close();
  }
  closeStorage();
  process.exit(0);
}

const program = new Command();

program
  .name('scenarii')
  .description('Execute periodic YAML-defined scenarios to test web applications')
  .version('1.0.0');

program
  .argument('<files...>', 'One or more YAML scenario files')
  .option('--headless <bool>', 'Run browser in headless mode', 'true')
  .option('--json', 'Output metrics as JSON')
  .option('--once', 'Run scenarios once without scheduling')
  .option('--db <path>', 'SQLite database path for persisting metrics')
  .action(async (files: string[], options) => {
    if (options.db) {
    initStorage(options.db);
    loadSettings();
    }

    const headless = options.headless !== 'false';
    const runOptions = { headless, json_output: options.json, persist: !!options.db };

    const scenarios = files.map((f) => {
      logger.info({ file: f }, 'Loading scenario');
      return loadScenarioFile(f);
    });

    if (options.once) {
      for (const scenario of scenarios) {
        await runScenario(scenario, runOptions);
      }
      return;
    }

    for (const scenario of scenarios) {
      if (scenario.schedule) {
        scheduleScenario(scenario, runOptions);
      } else {
        logger.info({ scenario: scenario.name }, 'No schedule, running once');
        await runScenario(scenario, runOptions);
      }
    }

    if (listScheduled().length > 0) {
      logger.info({ scheduled: listScheduled() }, 'Scheduled scenarios');
      logger.info('Press Ctrl+C to stop.');

      process.on('SIGINT', () => shutdown());
      process.on('SIGTERM', () => shutdown());
    }
  });

program
  .command('server')
  .description('Start the API server and Angular frontend')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--db <path>', 'SQLite database path', 'db/scenarii.db')
  .option('--scenarios-dir <path>', 'Directory containing YAML scenario files', './scenarios')
  .option('--settings <path>', 'Path to settings.yaml')
  .action(async (options) => {
    try {
      initStorage(options.db);
    } catch (err: unknown) {
      logger.error({ path: options.db, err: err instanceof Error ? err.message : String(err) }, 'Failed to initialize database');
      process.exit(1);
    }
    loadSettings(options.settings);
    watchSettings();

    const scenariosDir = path.resolve(options.scenariosDir);
    let scenarioFiles: string[];
    try {
      scenarioFiles = fs.readdirSync(scenariosDir)
        .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map(f => path.join(scenariosDir, f));
    } catch {
      logger.error(`Scenarios directory not found: ${scenariosDir}`);
      process.exit(1);
    }

    if (scenarioFiles.length === 0) {
      logger.warn(`No .yml or .yaml files found in ${scenariosDir} — server will start with no scenarios`);
    }

    const runOptions = { headless: true, persist: true };

    // Start the API server immediately so it's available
    const port = parseInt(options.port);
    logger.info({ port }, 'Initializing server');
    const server = createServer(port, scenariosDir, runOptions);

    // Schedule cron jobs first
    for (const file of scenarioFiles) {
      try {
        const scenario = loadScenarioFile(file);
        if (scenario.schedule) {
          scheduleScenario(scenario, runOptions);
        }
      } catch (err: unknown) {
        logger.error({ file, err: err instanceof Error ? err.message : err }, 'Failed to load scenario');
      }
    }

    if (listScheduled().length > 0) {
      logger.info({ scheduled: listScheduled() }, 'Scheduled scenarios');
    }

    scheduleReport(DAILY_REPORT_CRON);

    process.on('SIGINT', () => shutdown(server));
    process.on('SIGTERM', () => shutdown(server));
  });

program
  .command('validate')
  .description('Validate a scenario YAML file without running it')
  .argument('<file>', 'Path to scenario YAML file')
  .action((file: string) => {
    try {
      const scenario = loadScenarioFile(file);
      logger.info({ name: scenario.name, steps: scenario.steps.length, schedule: scenario.schedule || 'none' }, 'Scenario is valid');
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Scenario validation failed');
      process.exit(1);
    }
  });

program
  .command('trigger')
  .description('Run a scenario immediately')
  .argument('<file>', 'Path to scenario YAML file')
  .option('--headless <bool>', 'Run browser in headless mode', 'true')
  .option('--json', 'Output metrics as JSON')
  .option('--db <path>', 'SQLite database path')
  .action(async (file: string, options) => {
    if (options.db) {
      initStorage(options.db);
    }
    const headless = options.headless !== 'false';
    const runOptions: RunOptions = { headless, json_output: options.json, persist: !!options.db };
    const scenario = loadScenarioFile(file);
    logger.info({ scenario: scenario.name }, 'Triggering scenario');
    await runScenario(scenario, runOptions);
  });

program
  .command('status')
  .description('Show current status of scheduled scenarios')
  .action(() => {
    const scheduled = listScheduled();
    if (scheduled.length > 0) {
      logger.info({ scheduled }, 'Scheduled scenarios');
    } else {
      logger.info('No scheduled scenarios');
    }
    logger.info({ storageReady: isStorageReady() }, 'Storage status');
  });

program
  .command('config')
  .description('Generate a settings.yaml template')
  .option('-o, --output <path>', 'Output file path', 'settings.yaml')
  .action((options) => {
    const template = `# scenarii notification and API settings
# Uncomment and configure the channels you want to use.

# API authentication (optional)
# api:
#   auth:
#     enabled: true
#     api_key: your-secret-api-key

# Storage retention (optional, defaults to 7 days)
# storage:
#   retentionDays: 30

notifications:
  telegram:
    enabled: false
    # bot_token: your_telegram_bot_token
    # chat_id: your_chat_id
  email:
    enabled: false
    # to:
    #   - you@example.com
    mailgun:
      # api_key: your_mailgun_api_key
      # domain: your_mailgun_domain
      # from: scenarii@your-domain.com
  # Slack webhook notifications
  # slack:
  #   enabled: true
  #   webhook_url: https://hooks.slack.com/services/...
  # Discord webhook notifications
  # discord:
  #   enabled: true
  #   webhook_url: https://discord.com/api/webhooks/...
  # Generic webhook notifications
  # webhook:
  #   enabled: true
  #   url: https://your-webhook-endpoint.example.com/hook
`;
    fs.writeFileSync(options.output, template, 'utf-8');
    logger.info(`Settings template written to ${options.output}`);
  });

program.parse(process.argv);
