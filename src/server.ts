import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { getScenarioList, getScenarioHistory, getScenarioStepNames } from './storage';

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
  app.get('/api/scenarios', (_req, res) => {
    try {
      const list = getScenarioList();
      res.json(list);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
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
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  app.get('/api/scenarios/:name/history', (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const history = getScenarioHistory(req.params.name, days);
      const stepNames = getScenarioStepNames(req.params.name);
      res.json({ history, stepNames });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
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
  return server;
}
