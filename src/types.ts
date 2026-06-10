export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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

export interface BrowserExpect {
  has_text?: string;
  not_has_text?: string;
  url_contains?: string;
  selector_count?: number;
}

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
    | 'browser.uncheck';
  url?: string;
  selector?: string;
  value?: string;
  timeout?: number;
  script?: string;
  expect?: BrowserExpect;
  condition?: StepCondition;
}

export interface StepCondition {
  if_step: string;
  if_status?: number;
  if_success?: boolean;
}

export type Step = HttpStep | BrowserStep;

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

export interface AlertConfig {
  consecutive_failures?: number;
}

export interface StepMetrics {
  step_name: string;
  action: string;
  success: boolean;
  status_code?: number;
  response_time_ms: number;
  error?: string;
  timestamp: Date;
}

export interface ScenarioMetrics {
  scenario_name: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  success: boolean;
  steps: StepMetrics[];
  consecutive_failures?: number;
}

export interface StepProgress {
  scenario_name: string;
  step_name: string;
  action: string;
  status: 'running' | 'done' | 'error';
  response_time_ms?: number;
  error?: string;
}

export type Reporter = (metrics: ScenarioMetrics) => void;
