import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { getScenarioList, getScenarioHistory, getScenarioStepNames } from './storage';
import { initWebSocket } from './ws';
import { isStorageReady } from './storage';

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function parseDaysParam(value: string | undefined): number {
  if (value === undefined) return 7;
  const n = parseInt(value);
  if (isNaN(n) || n < 1 || n > 365) return 7;
  return n;
}

function sendError(res: express.Response, status: number, err: unknown): void {
  console.error(`[${status}]`, err instanceof Error ? err.message : err);
  res.status(status).json({ error: 'Internal server error' });
}

function requestLogger(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
}

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());
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
      const list = getScenarioList();
      const scenario = list.find((s) => s.name === req.params.name);
      if (!scenario) {
        res.status(404).json({ error: 'Scenario not found' });
        return;
      }

      const history = getScenarioHistory(req.params.name);
      const stepNames = getScenarioStepNames(req.params.name);

      const totalRuns = history.length;
      const passedRuns = history.filter(r => r.success).length;

      res.json({
        info: {
          ...scenario,
          total_runs: totalRuns,
          passed_runs: passedRuns,
          failed_runs: totalRuns - passedRuns,
          pass_rate: totalRuns > 0 ? Math.round(passedRuns / totalRuns * 100) : 0,
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
      const history = getScenarioHistory(req.params.name, days);
      const stepNames = getScenarioStepNames(req.params.name);
      res.json({ history, stepNames });
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
