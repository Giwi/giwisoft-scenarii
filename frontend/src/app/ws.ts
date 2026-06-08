export interface ScenarioRunEvent {
  type: 'scenario_run';
  scenario_name: string;
  success: boolean;
  duration_ms: number;
  timestamp: string;
}

export interface StepProgressEvent {
  type: 'step_progress';
  scenario_name: string;
  step_name: string;
  action: string;
  status: 'running' | 'done' | 'error';
  response_time_ms?: number;
  error?: string;
  timestamp: string;
}

type WsMessage = ScenarioRunEvent | StepProgressEvent;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let runListeners: Array<(event: ScenarioRunEvent) => void> = [];
let stepListeners: Array<(event: StepProgressEvent) => void> = [];

export function onScenarioRun(listener: (event: ScenarioRunEvent) => void): void {
  runListeners.push(listener);
  ensureConnected();
}

export function removeScenarioRunListener(listener: (event: ScenarioRunEvent) => void): void {
  runListeners = runListeners.filter(l => l !== listener);
}

export function onStepProgress(listener: (event: StepProgressEvent) => void): void {
  stepListeners.push(listener);
  ensureConnected();
}

export function removeStepProgressListener(listener: (event: StepProgressEvent) => void): void {
  stepListeners = stepListeners.filter(l => l !== listener);
}

function ensureConnected(): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING)) return;

  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsMessage;
        if (data.type === 'scenario_run') {
          runListeners.forEach(l => l(data as ScenarioRunEvent));
        } else if (data.type === 'step_progress') {
          stepListeners.forEach(l => l(data as StepProgressEvent));
        }
      } catch { /* ignore malformed messages */ }
    };

    ws.onclose = () => {
      ws = null;
      if ((runListeners.length > 0 || stepListeners.length > 0) && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          ensureConnected();
        }, 3000);
      }
    };

    ws.onerror = () => { ws?.close(); };
  } catch { /* connection will be retried on close */ }
}
