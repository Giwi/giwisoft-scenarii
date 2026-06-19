import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { ChildProcess } from 'child_process';
import { lightpanda } from '@lightpanda/browser';
import net from 'net';
import {
  getScenarioList, getScenarioDetail, getScenarioHistory, getScenarioHistoryCount, getScenarioPassedRunCount,
  getScenarioStepNames, getDistinctTags, getDbScenarioTags,
  isStorageReady, backupDatabase,
} from './storage';
import { initWebSocket } from './ws';
import { getSettings } from './settings';
import { loadScenarioFile, parseScenario, serializeScenario } from './parser';
import { runScenario, cancelScenario } from './runner';
import { pauseScenario, resumeScenario, isPaused, isScheduled, listScheduled } from './scheduler';
import { authMiddleware, handleOidcLogin, handleOidcCallback, handleAuthMe, handleLogout } from './auth';
import { handlePublicScenarioStatus, handlePublicScenarioApi } from './public-status';
import { metricsAuthMiddleware, handleMetrics } from './metrics-exporter';
import { escapeCsv, toCsv, parseDaysParam, parseLimitParam } from './helpers';
import logger from './logger';
import { DEFAULT_LIMIT } from './constants';

// Module-level state shared across request handlers
let _scenariosDir: string | undefined;
let _runOptions: { headless: boolean; persist: boolean; lightpandaUrl?: string } | undefined;

// Global Lightpanda process — started once with the server and shared across all worker threads.
// This keeps the headless browser alive for the server's lifetime, avoiding per-run startup
// overhead and preventing the browser page from being closed between steps.
let _lightpandaProc: (ChildProcess & { wsEndpoint?: string }) | null = null;
let _lightpandaPort: number | null = null;

const LIGHTPANDA_PORT = 9222;
const PORT_WAIT_TIMEOUT = 10000;

// Polls a TCP port until it becomes reachable or the timeout is exceeded.
function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${host}:${port}`));
        return;
      }
      const sock = new net.Socket();
      sock.setTimeout(2000);
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); setTimeout(tryConnect, 200); });
      sock.once('timeout', () => { sock.destroy(); setTimeout(tryConnect, 200); });
      sock.connect(port, host);
    }
    tryConnect();
  });
}

// Returns the WebSocket URL of the globally shared Lightpanda instance, if available.
export function getLightpandaUrl(): string | undefined {
  return _runOptions?.lightpandaUrl;
}

// Gracefully stops the global Lightpanda process on server shutdown.
// Called from index.ts shutdown handler.
export function closeLightpanda(): void {
  if (_lightpandaProc) {
    try {
      _lightpandaProc.stdout?.destroy();
      _lightpandaProc.stderr?.destroy();
      _lightpandaProc.kill();
    } catch { /* ignore */ }
    _lightpandaProc = null;
  }
}

// ──────────────────────────────────────────
// Request middleware
// ──────────────────────────────────────────

function requestIdMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const requestId = Math.random().toString(36).slice(2, 10);
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

function requestLogger(req: express.Request, res: express.Response, next: express.NextFunction): void {
  logger.info({ requestId: res.locals.requestId, method: req.method, url: req.url }, 'Request');
  next();
}

function sendError(res: express.Response, status: number, err: unknown): void {
  logger.error({ requestId: res.locals.requestId, status, err: err instanceof Error ? err.message : String(err) }, 'Request failed');
  res.status(status).json({ error: 'Internal server error' });
}

// ──────────────────────────────────────────
// Scenario handlers
// ──────────────────────────────────────────

function handleScenarioList(req: express.Request, res: express.Response): void {
  try {
    const tag = req.query.tag as string | undefined;
    const dbList = getScenarioList();
    const dbNames = new Set(dbList.map(s => s.name));

    const scheduledNames = listScheduled();
    for (const name of scheduledNames) {
      if (!dbNames.has(name)) {
        dbNames.add(name);
        dbList.push({
          name,
          last_run: null,
          last_success: null,
          last_duration_ms: null,
          total_runs: 0,
          tags: getDbScenarioTags(name),
        });
      }
    }

    const list = dbList.map(s => ({
      ...s,
      paused: isPaused(s.name),
      scheduled: isScheduled(s.name),
      depends_on: getScenarioDependsOn(s.name),
    }));

    res.json(tag ? list.filter(s => s.tags?.includes(tag)) : list);
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

function getScenarioDependsOn(name: string): string | undefined {
  if (!_scenariosDir) return undefined;
  try {
    const files = fs.readdirSync(_scenariosDir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const scenario = loadScenarioFile(path.join(_scenariosDir, file));
      if (scenario.name === name && scenario.depends_on) {
        return scenario.depends_on;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function handleScenarioDetail(req: express.Request, res: express.Response): void {
  try {
    const days = parseDaysParam(req.query.days as string);
    const limit = parseLimitParam(req.query.limit as string) ?? DEFAULT_LIMIT;
    const offset = parseLimitParam(req.query.offset as string) ?? 0;
    const name = req.params.name as string;
    const { info: rawInfo, history, stepNames, total } = getScenarioDetail(name, days, limit, offset);
    const passedRuns = getScenarioPassedRunCount(name, days);

    res.json({
      info: { ...rawInfo, total_runs: total, passed_runs: passedRuns, failed_runs: total - passedRuns, depends_on: getScenarioDependsOn(name) },
      history,
      stepNames,
    });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

function handleScenarioHistory(req: express.Request, res: express.Response): void {
  try {
    const name = req.params.name as string;
    const days = parseDaysParam(req.query.days as string);
    const limit = parseLimitParam(req.query.limit as string) ?? DEFAULT_LIMIT;
    const offset = parseLimitParam(req.query.offset as string) ?? 0;
    const total = getScenarioHistoryCount(name, days);
    const history = getScenarioHistory(name, days, limit, offset);
    const stepNames = getScenarioStepNames(name);
    res.json({ history, stepNames, total });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Triggers an immediate run of a scenario by loading its YAML file and passing it to the runner.
function handleRunNow(req: express.Request, res: express.Response): void {
  const name = req.params.name as string;
  if (!_scenariosDir) {
    res.status(400).json({ error: 'Server not configured for manual runs' });
    return;
  }
  try {
    const files = fs.readdirSync(_scenariosDir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const scenario = loadScenarioFile(path.join(_scenariosDir, file));
      if (scenario.name === name) {
        runScenario(scenario, _runOptions ?? { headless: true, persist: true });
        res.json({ status: 'triggered', scenario: name });
        return;
      }
    }
    res.status(404).json({ error: 'Scenario not found' });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Cancels a currently running scenario by terminating its worker thread.
function handleCancel(req: express.Request, res: express.Response): void {
  const name = req.params.name as string;
  if (cancelScenario(name)) {
    res.json({ status: 'cancelled', scenario: name });
  } else {
    res.status(404).json({ error: 'Scenario not currently running' });
  }
}

function handlePause(req: express.Request, res: express.Response): void {
  const name = req.params.name as string;
  if (pauseScenario(name)) {
    res.json({ status: 'paused', scenario: name });
  } else {
    res.status(404).json({ error: 'Scenario not found or not scheduled' });
  }
}

function handleResume(req: express.Request, res: express.Response): void {
  const name = req.params.name as string;
  if (resumeScenario(name)) {
    res.json({ status: 'resumed', scenario: name });
  } else {
    res.status(404).json({ error: 'Scenario not found or not scheduled' });
  }
}

// Exports a scenario definition as a downloadable YAML file.
function handleConfigExport(req: express.Request, res: express.Response): void {
  const name = req.params.name as string;
  if (!_scenariosDir) {
    res.status(400).json({ error: 'Server not configured for config export' });
    return;
  }
  try {
    const files = fs.readdirSync(_scenariosDir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const scenario = loadScenarioFile(path.join(_scenariosDir, file));
      if (scenario.name === name) {
        const yaml = serializeScenario(scenario);
        res.setHeader('Content-Type', 'text/yaml');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.yaml"`);
        res.send(yaml);
        return;
      }
    }
    res.status(404).json({ error: 'Scenario not found' });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Saves a new YAML definition for an existing scenario, validating the submitted content.
function handleConfigSave(req: express.Request, res: express.Response): void {
  if (!_scenariosDir) {
    res.status(400).json({ error: 'Server not configured for config save' });
    return;
  }
  try {
    const name = req.params.name as string;
    const body = req.body as { yaml?: string };
    if (!body.yaml) {
      res.status(400).json({ error: 'YAML content required' });
      return;
    }
    const scenario = parseScenario(body.yaml);
    if (scenario.name !== name) {
      res.status(400).json({ error: 'Scenario name in YAML does not match URL' });
      return;
    }
    const filePath = path.join(_scenariosDir, `${name}.yaml`);
    fs.writeFileSync(filePath, body.yaml, 'utf-8');
    res.json({ status: 'saved', scenario: name, path: filePath });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Deletes a scenario's YAML file from disk.
function handleConfigDelete(req: express.Request, res: express.Response): void {
  if (!_scenariosDir) {
    res.status(400).json({ error: 'Server not configured for config delete' });
    return;
  }
  try {
    const name = req.params.name as string;
    const files = fs.readdirSync(_scenariosDir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const scenario = loadScenarioFile(path.join(_scenariosDir, file));
      if (scenario.name === name) {
        fs.unlinkSync(path.join(_scenariosDir, file));
        res.json({ status: 'deleted', scenario: name });
        return;
      }
    }
    res.status(404).json({ error: 'Scenario not found' });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Exports scenario history as a downloadable JSON file.
function handleExportJson(req: express.Request, res: express.Response): void {
  try {
    const name = req.params.name as string;
    const days = parseDaysParam(req.query.days as string);
    const history = getScenarioHistory(name, days);
    const filename = `scenario-${name}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(history);
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Exports scenario history as a downloadable CSV file.
function handleExportCsv(req: express.Request, res: express.Response): void {
  try {
    const name = req.params.name as string;
    const days = parseDaysParam(req.query.days as string);
    const history = getScenarioHistory(name, days);
    const filename = `scenario-${name}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('text/csv');
    res.send(toCsv(history));
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Returns SLA statistics (total, passed, failed runs and percentage) for a scenario.
function handleSla(req: express.Request, res: express.Response): void {
  try {
    const name = req.params.name as string;
    const days = parseDaysParam(req.query.days as string);
    const total = getScenarioHistoryCount(name, days);
    const passed = getScenarioPassedRunCount(name, days);
    res.json({
      scenario: name, days,
      total_runs: total, passed_runs: passed, failed_runs: total - passed,
      sla: total > 0 ? Math.round((passed / total) * 1000) / 10 : 100,
    });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Returns all distinct tags across all scenarios.
function handleTags(_req: express.Request, res: express.Response): void {
  try {
    res.json(getDistinctTags());
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Returns aggregate health information for all scenarios (healthy/unhealthy counts).
function handleStatus(_req: express.Request, res: express.Response): void {
  try {
    const list = getScenarioList();
    res.json({
      scenarios: list.length,
      healthy: list.filter(s => s.last_success === 1).length,
      unhealthy: list.filter(s => s.last_success === 0).length,
      unknown: list.filter(s => s.last_success === null).length,
      storage_ready: isStorageReady(),
      tags: getDistinctTags(),
    });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Triggers an on-demand database backup to the configured backup directory.
function handleBackup(_req: express.Request, res: express.Response): void {
  try {
    const settings = getSettings();
    const dir = settings.storage?.backup?.directory || './backups';
    const dst = backupDatabase(dir);
    res.json({ status: 'ok', path: dst });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

// Health check — returns 200 when storage is ready, 503 otherwise.
function handleHealth(_req: express.Request, res: express.Response): void {
  if (isStorageReady()) {
    res.json({ status: 'ok' });
  } else {
    res.status(503).json({ status: 'error', message: 'Storage not initialized' });
  }
}

// ──────────────────────────────────────────
// App and server factory
// ──────────────────────────────────────────

// Creates and configures an Express application with all middleware and route handlers.
export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(helmet({
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(requestLogger);

  // OIDC auth routes (unauthenticated)
  app.get('/api/auth/login', handleOidcLogin);
  app.get('/api/auth/callback', handleOidcCallback);
  app.get('/api/auth/me', handleAuthMe);
  app.post('/api/auth/logout', handleLogout);
  app.use(authMiddleware);

  // Scenario CRUD and management
  app.get('/api/scenarios', handleScenarioList);
  app.get('/api/scenarios/:name', handleScenarioDetail);
  app.get('/api/scenarios/:name/history', handleScenarioHistory);
  app.post('/api/scenarios/:name/run', handleRunNow);
  app.post('/api/scenarios/:name/cancel', handleCancel);
  app.post('/api/scenarios/:name/pause', handlePause);
  app.post('/api/scenarios/:name/resume', handleResume);
  app.get('/api/scenarios/:name/config', handleConfigExport);
  app.put('/api/scenarios/:name/config', handleConfigSave);
  app.delete('/api/scenarios/:name/config', handleConfigDelete);
  app.get('/api/scenarios/:name/export/json', handleExportJson);
  app.get('/api/scenarios/:name/export/csv', handleExportCsv);
  app.get('/api/scenarios/:name/sla', handleSla);
  app.get('/api/tags', handleTags);
  app.get('/api/status', handleStatus);
  app.post('/api/backup', handleBackup);
  app.get('/api/health', handleHealth);
  app.get('/api/metrics', metricsAuthMiddleware, handleMetrics);

  // Public (unauthenticated) endpoints
  app.get('/api/public/scenario/:name', handlePublicScenarioApi);
  app.get('/public/status/:name', handlePublicScenarioStatus);

  // Serve Angular frontend in production (only if built)
  const frontendDir = path.join(__dirname, '../frontend/dist/frontend/browser');
  const frontendBuilt = fs.existsSync(path.join(frontendDir, 'index.html'));
  if (frontendBuilt) {
    app.use(express.static(frontendDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.sendFile(path.join(frontendDir, 'index.html'));
      } else {
        next();
      }
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({ message: 'scenarii API server — frontend not built, run `npm run build:frontend`' });
    });
  }

  return app;
}

// Creates the full server: Express app, global Lightpanda, HTTP listener, WebSocket, and backup scheduler.
export function createServer(port: number = 3000, scenariosDir?: string, runOptions?: { headless: boolean; persist: boolean }): http.Server {
  _scenariosDir = scenariosDir;
  if (runOptions) _runOptions = runOptions;
  const app = createApp();

  // Start Lightpanda headless browser globally so all workers share it
  (async () => {
    try {
      const proc = await lightpanda.serve({ host: '127.0.0.1', port: LIGHTPANDA_PORT });
      await waitForPort('127.0.0.1', LIGHTPANDA_PORT, PORT_WAIT_TIMEOUT);
      _lightpandaProc = proc;
      _lightpandaPort = LIGHTPANDA_PORT;
      const url = `http://127.0.0.1:${LIGHTPANDA_PORT}`;
      if (_runOptions) _runOptions.lightpandaUrl = url;
      logger.info({ port: LIGHTPANDA_PORT }, 'Lightpanda headless browser started');
    } catch (err: unknown) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start global Lightpanda — workers will start per-run');
    }
  })();

  const server = app.listen(port, () => {
    logger.info({ port }, 'API server running');
  });
  initWebSocket(server);

  // Schedule automated database backups if enabled in settings
  const s = getSettings();
  if (s.storage?.backup?.enabled) {
    try {
      const backupCron = s.storage.backup.cron || '0 4 * * *';
      if (require('node-cron').validate(backupCron)) {
        require('node-cron').schedule(backupCron, () => {
          try {
            const dir = s.storage?.backup?.directory || './backups';
            const dst = backupDatabase(dir);
            logger.info({ path: dst }, 'Automated database backup completed');
          } catch (err: unknown) {
            logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Automated backup failed');
          }
        });
        logger.info({ cron: backupCron }, 'Backup scheduled');
      }
    } catch (err: unknown) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Failed to schedule backup');
    }
  }

  return server;
}
