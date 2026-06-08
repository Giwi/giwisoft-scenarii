import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { getScenarioList, getScenarioDetail, getScenarioHistory, getScenarioHistoryCount, getScenarioStepNames } from './storage';
import { initWebSocket } from './ws';
import { isStorageReady } from './storage';
import { getSettings } from './settings';
import { loadScenarioFile } from './parser';
import { runScenario } from './runner';
import { pauseScenario, resumeScenario, isPaused } from './scheduler';
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
    }));
    res.json(list);
  } catch (err: unknown) {
    sendError(res, 500, err);
  }
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

  app.get('/api/scenarios', handleScenarioList);
  app.get('/api/scenarios/:name', handleScenarioDetail);
  app.get('/api/scenarios/:name/history', handleScenarioHistory);
  app.post('/api/scenarios/:name/run', handleRunNow);
  app.post('/api/scenarios/:name/pause', handlePause);
  app.post('/api/scenarios/:name/resume', handleResume);
  app.get('/api/scenarios/:name/export/json', handleExportJson);
  app.get('/api/scenarios/:name/export/csv', handleExportCsv);
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
  return server;
}
