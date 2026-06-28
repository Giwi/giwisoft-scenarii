// Supported HTTP methods for http.* actions
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Expectations that can be asserted on an HTTP response
export interface HttpExpect {
  status?: number;
  status_in?: number[];
  body_contains?: string;
  body_matches?: string;
  header_contains?: string;
  header_matches?: string;
  json_path?: string;
  json_value?: unknown;
  response_time_under?: number;
}

// An HTTP action step within a scenario
export interface HttpStep {
  name: string;
  action: 'http.get' | 'http.post' | 'http.put' | 'http.patch' | 'http.delete';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  condition?: StepCondition;
  expect?: HttpExpect;
  variables?: Record<string, string>;
}

// Expectations that can be asserted on a browser page state
export interface BrowserExpect {
  has_text?: string;
  not_has_text?: string;
  url_contains?: string;
  selector_count?: number;
}

// A browser automation step within a scenario
export interface BrowserStep {
  name: string;
  action:
    | 'browser.navigate'
    | 'browser.fill'
    | 'browser.click'
    | 'browser.wait_for'
    | 'browser.screenshot'
    | 'browser.screenshot_compare'
    | 'browser.select'
    | 'browser.evaluate'
    | 'browser.type'
    | 'browser.check'
    | 'browser.uncheck'
    | 'browser.scroll';
  url?: string;
  selector?: string;
  value?: string;
  timeout?: number;
  script?: string;
  expect?: BrowserExpect;
  condition?: StepCondition;
}

// A condition that controls whether a step runs, based on a previous step's outcome
export interface StepCondition {
  if_step: string;
  if_status?: number;
  if_success?: boolean;
}

// A step that includes steps from another scenario
export interface IncludeStep {
  include: string;
  name?: string;
}

// Union of all supported step types
export type Step = HttpStep | BrowserStep | IncludeStep;

// A full scenario definition parsed from YAML
export interface Scenario {
  name: string;
  description?: string;
  schedule?: string;
  base_url?: string;
  headless?: boolean;
  ignoreHTTPSErrors?: boolean;
  timeout?: number;
  tags?: string[];
  depends_on?: string;
  steps: Step[];
  alert?: AlertConfig;
}

// Per-scenario alerting threshold overrides
export interface AlertConfig {
  consecutive_failures?: number;
}

// Runtime metrics for a single step execution
export interface StepMetrics {
  step_name: string;
  action: string;
  success: boolean;
  status_code?: number;
  response_time_ms: number;
  error?: string;
  timestamp: Date;
}

// Aggregate metrics for a full scenario run
export interface ScenarioMetrics {
  scenario_name: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  success: boolean;
  steps: StepMetrics[];
  consecutive_failures?: number;
}

// Real-time progress update sent via WebSocket during a run
export interface StepProgress {
  scenario_name: string;
  step_name: string;
  action: string;
  status: 'running' | 'done' | 'error';
  response_time_ms?: number;
  error?: string;
}

// Options passed to the scenario runner (both CLI and server mode)
export interface RunOptions {
  headless?: boolean;
  json_output?: boolean;
  persist?: boolean;
  lightpandaPort?: number;
  lightpandaUrl?: string;
  timeout?: number;
  ignoreHTTPSErrors?: boolean;
  scenariosDir?: string;
}

// Function signature for output reporters (console or JSON)
export type Reporter = (metrics: ScenarioMetrics) => void;
