import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import logger from './logger';

// Singleton WebSocket server instance
let wss: WebSocketServer | null = null;

// Attaches a WebSocket server to the given HTTP server on the /ws path.
export function initWebSocket(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('error', (err) => {
      logger.warn({ err }, 'WebSocket client error');
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'WebSocket server error');
  });
}

// Broadcasts a completed scenario run to all connected WebSocket clients.
export function broadcastScenarioRun(data: {
  scenario_name: string;
  success: boolean;
  duration_ms: number;
}): void {
  if (!wss) return;

  const message = JSON.stringify({
    type: 'scenario_run',
    ...data,
    timestamp: new Date().toISOString(),
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Sends a per-step progress update to all connected WebSocket clients.
export function broadcastStepProgress(data: {
  scenario_name: string;
  step_name: string;
  action: string;
  status: 'running' | 'done' | 'error';
  response_time_ms?: number;
  error?: string;
}): void {
  if (!wss) return;

  const message = JSON.stringify({
    type: 'step_progress',
    ...data,
    timestamp: new Date().toISOString(),
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
