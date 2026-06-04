import express from 'express';
import cors from 'cors';
import path from 'path';
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

      res.json({ info: scenario, history, stepNames });
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

  // Serve Angular frontend in production
  const frontendPath = path.join(__dirname, '../frontend/dist/frontend/browser');
  app.use(express.static(frontendPath));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(path.join(frontendPath, 'index.html'));
    } else {
      next();
    }
  });

  return app;
}

export function createServer(port: number = 3000): http.Server {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`Scenarii API server running on http://localhost:${port}`);
  });
  return server;
}
