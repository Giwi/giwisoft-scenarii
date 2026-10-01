#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { loadScenarioFile } from './config/parser';
import { runScenario, RunOptions } from './runner/runner';
import { scheduleScenario, stopAll, listScheduled, scheduleReport, watchScenarios } from './runner/scheduler';
import { initStorage, closeStorage, isStorageReady } from './config/storage';
import { loadSettings, watchSettings } from './config/settings';
import {
  ensureDefaultUser, listUsers, createUser, setPassword, setRole, deleteUser,
  generatePassword, normalizeRole,
} from './config/users';
import { createServer, closeLightpanda } from './routes/server';
import logger from './utils/logger';
import { DAILY_REPORT_CRON } from './utils/constants';

// Top-level handlers for uncaught errors and promise rejections
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason instanceof Error ? reason.message : reason }, 'Unhandled rejection');
});

// Gracefully stops schedulers, Lightpanda, server, and the database before exiting.
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

// Version reported by --version, read from package.json so it always tracks the release tag.
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')).version as string;

// Keep each subcommand's own options (e.g. `server --db`) instead of letting the root
// program swallow duplicate flags such as --db.
program.enablePositionalOptions();

program
  .name('scenarii')
  .description('Execute periodic YAML-defined scenarios to test web applications')
  .version(VERSION);

// Default command: load scenario files and run or schedule them.
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
    const runOptions = { headless, json_output: options.json, persist: !!options.db, scenariosDir: path.dirname(path.resolve(files[0])) };

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

// Server command: starts the HTTP API server, loads scenarios, and initialises scheduling.
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
    ensureDefaultUser();

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

    const runOptions = { headless: true, persist: true, scenariosDir };

    // Start the API server immediately so it's available
    const port = parseInt(options.port);
    logger.info({ port }, 'Initializing server');
    const server = createServer(port, scenariosDir, runOptions);

    // Schedule cron jobs first
    for (const file of scenarioFiles) {
      try {
        const scenario = loadScenarioFile(file);
        if (scenario.schedule) {
          const stat = fs.statSync(file);
          scheduleScenario(scenario, runOptions, file, stat.mtimeMs);
        }
      } catch (err: unknown) {
        logger.error({ file, err: err instanceof Error ? err.message : err }, 'Failed to load scenario');
      }
    }

    if (listScheduled().length > 0) {
      logger.info({ scheduled: listScheduled() }, 'Scheduled scenarios');
    }

    // Start periodic watcher to pick up new/removed scenario files
    watchScenarios(scenariosDir, runOptions);

    scheduleReport(DAILY_REPORT_CRON);

    process.on('SIGINT', () => shutdown(server));
    process.on('SIGTERM', () => shutdown(server));
  });

// Validate command: checks YAML syntax without executing.
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

// Trigger command: immediately runs a scenario file.
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

// Status command: lists scheduled scenarios and storage readiness.
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

// User command: manages the local user DB used for authentication.
program
  .command('user')
  .description('Manage dashboard users')
  .argument('<action>', 'list | add <username> [password] [role] | passwd <username> [password] | role <username> <role> | del <username>')
  .argument('[args...]', 'Arguments for the action')
  .option('--db <path>', 'SQLite database path', 'db/scenarii.db')
  .action((action: string, args: string[], options) => {
    try {
      initStorage(options.db);
    } catch (err: unknown) {
      logger.error({ path: options.db, err: err instanceof Error ? err.message : String(err) }, 'Failed to initialize database');
      process.exit(1);
    }

    if (action === 'list') {
      const users = listUsers();
      for (const u of users) logger.info({ user: u.username, role: u.role, created_at: u.created_at }, 'User');
      if (users.length === 0) logger.info('No users: start the server once to create the default user');
      return;
    }

    if (action === 'add') {
      const username = args[0];
      if (!username) {
        logger.error('Usage: scenarii user add <username> [password] [admin|user]');
        process.exit(1);
      }
      const role = normalizeRole(args[2]);
      const password = args[1] || generatePassword();
      if (!createUser(username, password, role)) {
        logger.error({ user: username }, 'User already exists');
        process.exit(1);
      }
      logger.info({ user: username, role, password }, 'User created');
      return;
    }

    if (action === 'passwd') {
      const username = args[0];
      if (!username) {
        logger.error('Usage: scenarii user passwd <username> [password]');
        process.exit(1);
      }
      const password = args[1] || generatePassword();
      if (!setPassword(username, password)) {
        logger.error({ user: username }, 'Unknown user');
        process.exit(1);
      }
      logger.info({ user: username }, 'Password updated');
      return;
    }

    if (action === 'role') {
      const [username, role] = args;
      if (!username || !role) {
        logger.error('Usage: scenarii user role <username> <admin|user>');
        process.exit(1);
      }
      if (!setRole(username, normalizeRole(role))) {
        logger.error({ user: username }, 'Unknown user');
        process.exit(1);
      }
      logger.info({ user: username, role: normalizeRole(role) }, 'Role updated');
      return;
    }

    if (action === 'del') {
      const username = args[0];
      if (!username) {
        logger.error('Usage: scenarii user del <username>');
        process.exit(1);
      }
      if (!deleteUser(username)) {
        logger.error({ user: username }, 'Unknown user');
        process.exit(1);
      }
      logger.info({ user: username }, 'User deleted');
      return;
    }

    logger.error(`Unknown action "${action}": use list, add, passwd, role, or del`);
    process.exit(1);
  });

// Config command: generates a boilerplate settings.yaml file.
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

# Dashboard authentication: enabled by default, local user DB.
# The default user is created on first start with an admin role and a generated
# password printed in the logs. Only admins can add users (API or CLI).
# Roles: admin | user
# Add an oidc: block to authenticate through an OIDC provider instead: roles are
# then derived from the provider groups (admin_group grants admin).
# auth:
#   enabled: true
#   default_user: admin
#   default_user_role: admin
#   oidc:
#     issuer_url: https://accounts.google.com
#     client_id: your-client-id
#     client_secret: your-client-secret
#     redirect_uri: http://localhost:3000/api/auth/callback
#     username_claim: preferred_username
#     groups_claim: groups
#     admin_group: scenarii-admins

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
