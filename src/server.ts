import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import {
  getScenarioList, getScenarioDetail, getScenarioHistory, getScenarioHistoryCount,
  getScenarioStepNames, getDistinctTags, getNotificationMetrics,
  isStorageReady, backupDatabase, getLastRunSuccess,
} from './storage';
import { initWebSocket } from './ws';
import { getSettings } from './settings';
import { loadScenarioFile, parseScenario, serializeScenario } from './parser';
import { runScenario, cancelScenario } from './runner';
import { pauseScenario, resumeScenario, isPaused, isScheduled } from './scheduler';
import { ScenarioMetrics } from './types';
import logger from './logger';
import { DEFAULT_LIMIT, MIN_DAYS, MAX_DAYS, DEFAULT_HISTORY_DAYS } from './constants';

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function parseDaysParam(value: string | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_DAYS;
  const n = parseInt(value);
  if (isNaN(n) || n < MIN_DAYS || n > MAX_DAYS) return DEFAULT_HISTORY_DAYS;
  return n;
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function toCsv(history: ScenarioMetrics[]): string {
  const header = 'started_at,finished_at,duration_ms,success,step_name,step_action,step_success,step_response_time_ms,step_error\n';
  const rows = history.flatMap(r =>
    r.steps.map(s =>
      `${r.started_at.toISOString()},${r.finished_at.toISOString()},${r.duration_ms},${r.success},${escapeCsv(s.step_name)},${escapeCsv(s.action)},${s.success},${s.response_time_ms},${escapeCsv(s.error || '')}`
    )
  );
  return header + rows.join('\n');
}

function parseLimitParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value);
  return isNaN(n) ? undefined : n;
}

const sessions = new Map<string, { createdAt: number }>();

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) cookies[key] = val;
    }
  }
  return cookies;
}

const SESSION_COOKIE = 'scenarii-session';

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const config = getSettings().auth;
  if (!config?.enabled) return next();
  if (!req.path.startsWith('/api/')) return next();
  const authPath = '/api/auth/';
  if (req.path.startsWith(authPath) || req.path === '/api/health' || req.path === '/api/status') return next();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

async function fetchOidcDiscovery(issuerUrl: string): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const data = await res.json() as { authorization_endpoint: string; token_endpoint: string };
  return {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
  };
}

const oidcStates = new Map<string, { createdAt: number }>();
const STATE_TTL = 10 * 60 * 1000; // 10 minutes

function cleanOidcStates(): void {
  const now = Date.now();
  for (const [key, val] of oidcStates) {
    if (now - val.createdAt > STATE_TTL) oidcStates.delete(key);
  }
}

function handleOidcLogin(req: express.Request, res: express.Response): void {
  const config = getSettings().auth;
  if (!config?.enabled || !config.oidc) {
    res.status(400).json({ error: 'OIDC not configured' });
    return;
  }
  const oidc = config.oidc;
  cleanOidcStates();

  const state = crypto.randomBytes(16).toString('hex');
  oidcStates.set(state, { createdAt: Date.now() });

  const scopes = encodeURIComponent(oidc.scopes || 'openid profile email');
  const authUrl = `${oidc.issuer_url.replace(/\/$/, '')}/authorize?response_type=code&client_id=${encodeURIComponent(oidc.client_id)}&redirect_uri=${encodeURIComponent(oidc.redirect_uri)}&scope=${scopes}&state=${state}`;

  res.redirect(authUrl);
}

async function handleOidcCallback(req: express.Request, res: express.Response): Promise<void> {
  const config = getSettings().auth;
  if (!config?.enabled || !config.oidc) {
    res.status(400).json({ error: 'OIDC not configured' });
    return;
  }
  const oidc = config.oidc;
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state parameter' });
    return;
  }

  cleanOidcStates();
  if (!oidcStates.has(state)) {
    res.status(400).json({ error: 'Invalid or expired state parameter' });
    return;
  }
  oidcStates.delete(state);

  try {
    const discovery = await fetchOidcDiscovery(oidc.issuer_url);
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oidc.redirect_uri,
        client_id: oidc.client_id,
        client_secret: oidc.client_secret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error({ status: tokenRes.status, body: errText }, 'OIDC token exchange failed');
      res.status(500).json({ error: 'Token exchange failed' });
      return;
    }

    const sessionId = generateSessionId();
    sessions.set(sessionId, { createdAt: Date.now() });

    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    res.redirect('/');
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'OIDC callback failed');
    res.status(500).json({ error: 'OIDC authentication failed' });
  }
}

function handleAuthMe(req: express.Request, res: express.Response): void {
  const config = getSettings().auth;
  const configured = !!(config?.enabled && config?.oidc);
  if (!configured) {
    res.json({ authenticated: false, configured: false });
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  res.json({
    authenticated: !!sessionId && sessions.has(sessionId),
    configured: true,
  });
}

function handleLogout(req: express.Request, res: express.Response): void {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ status: 'logged_out' });
}

function requestIdMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const requestId = Math.random().toString(36).slice(2, 10);
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

let _scenariosDir: string | undefined;
let _runOptions: { headless: boolean; persist: boolean } | undefined;

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

function handleTags(_req: express.Request, res: express.Response): void {
  try {
    const tags = getDistinctTags();
    res.json(tags);
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

function handleStatus(_req: express.Request, res: express.Response): void {
  try {
    const list = getScenarioList();
    const info = {
      scenarios: list.length,
      healthy: list.filter(s => s.last_success === 1).length,
      unhealthy: list.filter(s => s.last_success === 0).length,
      unknown: list.filter(s => s.last_success === null).length,
      storage_ready: isStorageReady(),
      tags: getDistinctTags(),
    };
    res.json(info);
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

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

function sendError(res: express.Response, status: number, err: unknown): void {
  logger.error({ requestId: res.locals.requestId, status, err: err instanceof Error ? err.message : String(err) }, 'Request failed');
  res.status(status).json({ error: 'Internal server error' });
}

function requestLogger(req: express.Request, res: express.Response, next: express.NextFunction): void {
  logger.info({ requestId: res.locals.requestId, method: req.method, url: req.url }, 'Request');
  next();
}

function handleScenarioList(req: express.Request, res: express.Response): void {
  try {
    const tag = req.query.tag as string | undefined;
    const list = getScenarioList(tag || undefined).map(s => ({
      ...s,
      paused: isPaused(s.name),
      scheduled: isScheduled(s.name),
      depends_on: getScenarioDependsOn(s.name),
    }));
    res.json(list);
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

    const passedRuns = history.filter(r => r.success).length;

    res.json({
      info: {
        ...rawInfo,
        total_runs: total,
        passed_runs: passedRuns,
        failed_runs: total - passedRuns,
        pass_rate: total > 0 ? Math.round(passedRuns / total * 100) : 0,
        depends_on: getScenarioDependsOn(name),
      },
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

function handleCancel(req: express.Request, res: express.Response): void {
  const name = req.params.name as string;
  if (cancelScenario(name)) {
    res.json({ status: 'cancelled', scenario: name });
  } else {
    res.status(404).json({ error: 'Scenario not currently running' });
  }
}

function handleSla(req: express.Request, res: express.Response): void {
  try {
    const name = req.params.name as string;
    const days = parseDaysParam(req.query.days as string);
    const total = getScenarioHistoryCount(name, days);
    const history = getScenarioHistory(name, days);
    const passed = history.filter(r => r.success).length;
    res.json({
      scenario: name,
      days,
      total_runs: total,
      passed_runs: passed,
      failed_runs: total - passed,
      sla: total > 0 ? Math.round((passed / total) * 1000) / 10 : 100,
    });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

function handleBackup(_req: express.Request, res: express.Response): void {
  try {
    const settings = getSettings();
    const dir = settings.storage?.backup?.directory || './backups';
    const path = backupDatabase(dir);
    res.json({ status: 'ok', path });
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
}

function handleHealth(_req: express.Request, res: express.Response): void {
  if (isStorageReady()) {
    res.json({ status: 'ok' });
  } else {
    res.status(503).json({ status: 'error', message: 'Storage not initialized' });
  }
}

function metricsAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const config = getSettings().api?.auth;
  if (!config?.enabled) return next();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || header.slice(7) !== config.api_key) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function handleMetrics(_req: express.Request, res: express.Response): void {
  try {
    const list = getScenarioList();
    const lines: string[] = [];

    lines.push('# HELP scenarii_scenario_runs_total Total number of scenario runs');
    lines.push('# TYPE scenarii_scenario_runs_total counter');
    for (const s of list) {
      lines.push(`scenarii_scenario_runs_total{scenario="${escapePrometheusLabel(s.name)}"} ${s.total_runs}`);
    }

    lines.push('');
    lines.push('# HELP scenarii_scenario_duration_ms Latest scenario execution duration in milliseconds');
    lines.push('# TYPE scenarii_scenario_duration_ms gauge');
    for (const s of list) {
      if (s.last_duration_ms !== null) {
        lines.push(`scenarii_scenario_duration_ms{scenario="${escapePrometheusLabel(s.name)}"} ${s.last_duration_ms}`);
      }
    }

    lines.push('');
    lines.push('# HELP scenarii_scenario_success Latest scenario run success (1=pass, 0=fail)');
    lines.push('# TYPE scenarii_scenario_success gauge');
    for (const s of list) {
      if (s.last_success !== null) {
        lines.push(`scenarii_scenario_success{scenario="${escapePrometheusLabel(s.name)}"} ${s.last_success}`);
      }
    }

    lines.push('');
    lines.push('# HELP scenarii_scenario_last_run_seconds Unix timestamp of the last scenario run');
    lines.push('# TYPE scenarii_scenario_last_run_seconds gauge');
    for (const s of list) {
      if (s.last_run) {
        const ts = Math.floor(new Date(s.last_run).getTime() / 1000);
        lines.push(`scenarii_scenario_last_run_seconds{scenario="${escapePrometheusLabel(s.name)}"} ${ts}`);
      }
    }

    const stepLines: string[] = [];
    for (const s of list) {
      try {
        const history = getScenarioHistory(s.name, DEFAULT_HISTORY_DAYS);
        if (history.length > 0) {
          const latest = history[0];
          for (const step of latest.steps) {
            stepLines.push(`scenarii_step_duration_ms{scenario="${escapePrometheusLabel(s.name)}",step="${escapePrometheusLabel(step.step_name)}",action="${escapePrometheusLabel(step.action)}"} ${step.response_time_ms}`);
            stepLines.push(`scenarii_step_success{scenario="${escapePrometheusLabel(s.name)}",step="${escapePrometheusLabel(step.step_name)}",action="${escapePrometheusLabel(step.action)}"} ${step.success ? 1 : 0}`);
          }
        }
      } catch (err: unknown) {
        logger.warn({ scenario: s.name, err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch history for metrics');
      }
    }

    if (stepLines.length > 0) {
      lines.push('');
      lines.push('# HELP scenarii_step_duration_ms Step execution duration in milliseconds');
      lines.push('# TYPE scenarii_step_duration_ms gauge');
      lines.push('');
      lines.push('# HELP scenarii_step_success Step success (1=pass, 0=fail)');
      lines.push('# TYPE scenarii_step_success gauge');
      lines.push(...stepLines);
    }

    const notifMetrics = getNotificationMetrics();
    lines.push('');
    lines.push('# HELP scenarii_notification_delivery_total Total notifications sent');
    lines.push('# TYPE scenarii_notification_delivery_total counter');
    lines.push(`scenarii_notification_delivery_total{status="success"} ${notifMetrics.success}`);
    lines.push(`scenarii_notification_delivery_total{status="failure"} ${notifMetrics.failure}`);

    lines.push('');
    lines.push('# EOF');
    res.type('text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (err: unknown) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).type('text/plain').send('# error: Internal server error\n');
  }
}

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(helmet());
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(requestLogger);

  app.get('/api/auth/login', handleOidcLogin);
  app.get('/api/auth/callback', handleOidcCallback);
  app.get('/api/auth/me', handleAuthMe);
  app.post('/api/auth/logout', handleLogout);
  app.use(authMiddleware);

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

export function createServer(port: number = 3000, scenariosDir?: string, runOptions?: { headless: boolean; persist: boolean }): http.Server {
  _scenariosDir = scenariosDir;
  if (runOptions) _runOptions = runOptions;
  const app = createApp();
  const server = app.listen(port, () => {
    logger.info({ port }, 'API server running');
  });
  initWebSocket(server);

  const s = getSettings();
  if (s.storage?.backup?.enabled) {
    try {
      const backupCron = s.storage.backup.cron || '0 4 * * *';
      if (require('node-cron').validate(backupCron)) {
        require('node-cron').schedule(backupCron, () => {
          try {
            const dir = s.storage?.backup?.directory || './backups';
            const path = backupDatabase(dir);
            logger.info({ path }, 'Automated database backup completed');
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
