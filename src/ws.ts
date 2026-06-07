import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('error', (err) => {
      console.warn('WebSocket client error:', err);
    });
  });

  wss.on('error', (err) => {
    console.error('WebSocket server error:', err);
  });
}

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
