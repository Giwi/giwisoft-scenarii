import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { getScenarioList, getScenarioDetail, getScenarioHistory, getScenarioHistoryCount, getScenarioStepNames } from './storage';
import { initWebSocket } from './ws';
import { isStorageReady } from './storage';
import { ScenarioMetrics } from './types';

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function parseDaysParam(value: string | undefined): number {
  if (value === undefined) return 7;
  const n = parseInt(value);
  if (isNaN(n) || n < 1 || n > 365) return 7;
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

function sendError(res: express.Response, status: number, err: unknown): void {
  console.error(`[${res.locals.requestId ?? '-'}] [${status}]`, err instanceof Error ? err.message : err);
  res.status(status).json({ error: 'Internal server error' });
}

function requestLogger(req: express.Request, res: express.Response, next: express.NextFunction): void {
  console.log(`${new Date().toISOString()} [${res.locals.requestId}] ${req.method} ${req.url}`);
  next();
}

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(requestLogger);

  app.get('/api/scenarios', (_req, res) => {
    try {
      const list = getScenarioList();
      res.json(list);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  app.get('/api/scenarios/:name', (req, res) => {
    try {
      const days = parseDaysParam(req.query.days as string);
      const limit = parseLimitParam(req.query.limit as string) ?? 50;
      const offset = parseLimitParam(req.query.offset as string) ?? 0;
      const { info: rawInfo, history, stepNames, total } = getScenarioDetail(req.params.name, days, limit, offset);

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
  });

  app.get('/api/scenarios/:name/history', (req, res) => {
    try {
      const days = parseDaysParam(req.query.days as string);
      const limit = parseLimitParam(req.query.limit as string) ?? 50;
      const offset = parseLimitParam(req.query.offset as string) ?? 0;
      const total = getScenarioHistoryCount(req.params.name, days);
      const history = getScenarioHistory(req.params.name, days, limit, offset);
      const stepNames = getScenarioStepNames(req.params.name);
      res.json({ history, stepNames, total });
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  app.get('/api/scenarios/:name/export/json', (req, res) => {
    try {
      const days = parseDaysParam(req.query.days as string);
      const history = getScenarioHistory(req.params.name, days);
      const filename = `scenario-${req.params.name}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.json(history);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  app.get('/api/scenarios/:name/export/csv', (req, res) => {
    try {
      const days = parseDaysParam(req.query.days as string);
      const history = getScenarioHistory(req.params.name, days);
      const filename = `scenario-${req.params.name}.csv`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.type('text/csv');
      res.send(toCsv(history));
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  app.get('/api/health', (_req, res) => {
    if (isStorageReady()) {
      res.json({ status: 'ok' });
    } else {
      res.status(503).json({ status: 'error', message: 'Storage not initialized' });
    }
  });

  app.get('/api/metrics', (_req, res) => {
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

      // Step-level metrics from the last run — single pass through recent runs
      const stepLines: string[] = [];
      for (const s of list) {
        try {
          const history = getScenarioHistory(s.name, 7);
          if (history.length > 0) {
            const latest = history[0];
            for (const step of latest.steps) {
              stepLines.push(`scenarii_step_duration_ms{scenario="${escapePrometheusLabel(s.name)}",step="${escapePrometheusLabel(step.step_name)}",action="${escapePrometheusLabel(step.action)}"} ${step.response_time_ms}`);
              stepLines.push(`scenarii_step_success{scenario="${escapePrometheusLabel(s.name)}",step="${escapePrometheusLabel(step.step_name)}",action="${escapePrometheusLabel(step.action)}"} ${step.success ? 1 : 0}`);
            }
          }
        } catch (err) {
          console.warn(`Failed to fetch history for scenario "${s.name}" metrics:`, err);
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
      console.error('Failed to generate metrics:', err);
      res.status(500).type('text/plain').send('# error: Internal server error\n');
    }
  });

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

export function createServer(port: number = 3000): http.Server {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`Scenarii API server running on http://localhost:${port}`);
  });
  initWebSocket(server);
  return server;
}
