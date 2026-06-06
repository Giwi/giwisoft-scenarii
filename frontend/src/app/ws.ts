export interface ScenarioRunEvent {
  type: 'scenario_run';
  scenario_name: string;
  success: boolean;
  duration_ms: number;
  timestamp: string;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: Array<(event: ScenarioRunEvent) => void> = [];

export function onScenarioRun(listener: (event: ScenarioRunEvent) => void): void {
  listeners.push(listener);
  ensureConnected();
}

export function removeScenarioRunListener(listener: (event: ScenarioRunEvent) => void): void {
  listeners = listeners.filter(l => l !== listener);
}

function ensureConnected(): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING)) return;

  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'scenario_run') {
          listeners.forEach(l => l(data as ScenarioRunEvent));
        }
      } catch { /* ignore malformed messages */ }
    };

    ws.onclose = () => {
      ws = null;
      if (listeners.length > 0 && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          ensureConnected();
        }, 3000);
      }
    };

    ws.onerror = () => { ws?.close(); };
  } catch { /* connection will be retried on close */ }
}
