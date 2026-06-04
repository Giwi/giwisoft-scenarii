export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpExpect {
  status?: number;
  status_in?: number[];
  body_contains?: string;
  body_matches?: string;
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
}

export type Step = HttpStep | BrowserStep;

export interface Scenario {
  name: string;
  description?: string;
  schedule?: string;
  base_url?: string;
  headless?: boolean;
  steps: Step[];
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
}

export type Reporter = (metrics: ScenarioMetrics) => void;
