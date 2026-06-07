#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { loadScenarioFile } from './parser';
import { runScenario } from './runner';
import { scheduleScenario, stopAll, listScheduled, scheduleReport } from './scheduler';
import { sendDailyReport } from './report';
import { initStorage, closeStorage } from './storage';
import { loadSettings } from './settings';
import { createServer } from './server';

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
      console.log(`Loading scenario: ${f}`);
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
        console.log(`Scenario "${scenario.name}" has no schedule, running once...`);
        await runScenario(scenario, runOptions);
      }
    }

    if (listScheduled().length > 0) {
      console.log(`\nScheduled scenarios: ${listScheduled().join(', ')}`);
      console.log('Press Ctrl+C to stop.');

      process.on('SIGINT', () => {
        console.log('\nStopping all scheduled tasks...');
        stopAll();
        closeStorage();
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        stopAll();
        closeStorage();
        process.exit(0);
      });
    }
  });

program
  .command('server')
  .description('Start the API server and Angular frontend')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--db <path>', 'SQLite database path', 'db/scenarii.db')
  .option('--scenarios-dir <path>', 'Directory containing YAML scenario files', './scenarios')
  .action(async (options) => {
    initStorage(options.db);
    loadSettings(options.settings);

    const scenariosDir = path.resolve(options.scenariosDir);
    let scenarioFiles: string[];
    try {
      scenarioFiles = fs.readdirSync(scenariosDir)
        .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map(f => path.join(scenariosDir, f));
    } catch {
      console.error(`Scenarios directory not found: ${scenariosDir}`);
      process.exit(1);
    }

    if (scenarioFiles.length === 0) {
      console.error(`No .yml or .yaml files found in ${scenariosDir}`);
      process.exit(1);
    }

    const runOptions = { headless: true, persist: true };

    // Start the API server immediately so it's available
    const port = parseInt(options.port);
    console.log(`Initializing scenarii server on port ${port}...`);
    createServer(port);

    // Schedule cron jobs first
    for (const file of scenarioFiles) {
      try {
        const scenario = loadScenarioFile(file);
        if (scenario.schedule) {
          scheduleScenario(scenario, runOptions);
        }
      } catch (err: unknown) {
        console.error(`Failed to load ${file}:`, err instanceof Error ? err.message : err);
      }
    }

    if (listScheduled().length > 0) {
      console.log(`\nScheduled scenarios: ${listScheduled().join(', ')}`);
    }

    // Run initial execution in background sequentially (Lightpanda can't handle concurrency)
    (async () => {
      for (const file of scenarioFiles) {
        try {
          const scenario = loadScenarioFile(file);
          console.log(`Running scenario "${scenario.name}"...`);
          await runScenario(scenario, runOptions);
        } catch (err: unknown) {
          console.error(`Failed to run ${file}:`, err instanceof Error ? err.message : err);
        }
      }
      sendDailyReport();
      scheduleReport('0 8 * * *');
    })();

    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      stopAll();
      closeStorage();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      stopAll();
      closeStorage();
      process.exit(0);
    });
  });

program
  .command('config')
  .description('Generate a settings.yaml template')
  .option('-o, --output <path>', 'Output file path', 'settings.yaml')
  .action((options) => {
    const template = `# scenarii notification settings
# Uncomment and configure the channels you want to use.

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
`;
    fs.writeFileSync(options.output, template, 'utf-8');
    console.log(`Settings template written to ${options.output}`);
  });

program.parse(process.argv);
