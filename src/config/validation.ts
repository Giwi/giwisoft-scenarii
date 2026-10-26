import cron from 'node-cron';

// Allowed keys are listed next to the types so that a field added in one place but not
// the other fails loudly instead of being silently dropped by the parser.

const SCENARIO_KEYS = [
  'name', 'description', 'schedule', 'base_url', 'variables', 'headers', 'headless',
  'ignoreHTTPSErrors', 'timeout', 'tags', 'depends_on', 'group', 'time_windows', 'steps', 'alert',
] as const;

const STEP_COMMON_KEYS = ['name', 'action', 'timeout', 'condition'] as const;

const HTTP_KEYS = [...STEP_COMMON_KEYS, 'url', 'headers', 'body', 'expect', 'variables'] as const;
const BROWSER_KEYS = [...STEP_COMMON_KEYS, 'url', 'selector', 'value', 'script', 'expect', 'variables'] as const;
const INCLUDE_KEYS = ['include', 'name'] as const;

const HTTP_ACTIONS = ['http.get', 'http.post', 'http.put', 'http.patch', 'http.delete'] as const;
const BROWSER_ACTIONS = [
  'browser.navigate', 'browser.fill', 'browser.click', 'browser.wait_for', 'browser.screenshot',
  'browser.screenshot_compare', 'browser.select', 'browser.evaluate', 'browser.type',
  'browser.check', 'browser.uncheck', 'browser.scroll',
] as const;

const HTTP_EXPECT_KEYS = [
  'status', 'status_in', 'body_contains', 'body_matches', 'header_contains', 'header_matches',
  'json_path', 'json_value', 'response_time_under', 'body_schema',
] as const;
const BROWSER_EXPECT_KEYS = ['has_text', 'not_has_text', 'url_contains', 'selector_count'] as const;
const CONDITION_KEYS = ['if_step', 'if_status', 'if_success'] as const;
const ALERT_KEYS = ['consecutive_failures'] as const;
const TIME_WINDOW_KEYS = ['start', 'end', 'timezone'] as const;
const SCHEMA_KEYS = [
  'type', 'properties', 'required', 'items', 'enum', 'pattern', 'min', 'max', 'nullable',
  'title', 'description',
] as const;
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null'] as const;

const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Levenshtein distance, used only for "did you mean" hints.
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function suggest(key: string, allowed: readonly string[]): string | undefined {
  const lower = key.toLowerCase();

  // A prefix match catches cases like `status_code` -> `status`, where edit distance is large.
  const prefixes = allowed
    .filter((candidate) => {
      const c = candidate.toLowerCase();
      return c.startsWith(lower) || lower.startsWith(c);
    })
    .sort((a, b) => a.length - b.length);
  if (prefixes.length > 0) return prefixes[0];

  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best && bestDistance <= (key.length <= 5 ? 1 : 2) ? best : undefined;
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const hint = suggest(key, allowed);
      throw new Error(`Unknown field "${key}" in ${where}${hint ? ` (did you mean "${hint}"?)` : ''}`);
    }
  }
}

function assertString(value: unknown, where: string, allowEmpty = false): void {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  if (!allowEmpty && value.trim() === '') throw new Error(`${where} must not be empty`);
}

function assertBoolean(value: unknown, where: string): void {
  if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`);
}

function assertNumber(value: unknown, where: string, min?: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} must be a number`);
  if (min !== undefined && value < min) throw new Error(`${where} must be at least ${min}`);
}

function assertInteger(value: unknown, where: string, min?: number, max?: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${where} must be an integer`);
  if (min !== undefined && value < min) throw new Error(`${where} must be at least ${min}`);
  if (max !== undefined && value > max) throw new Error(`${where} must be at most ${max}`);
}

function assertStringArray(value: unknown, where: string): void {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of strings`);
  value.forEach((item, index) => assertString(item, `${where}[${index}]`));
}

function assertStringRecord(value: unknown, where: string): void {
  if (!isObject(value)) throw new Error(`${where} must be an object of string values`);
  for (const [key, item] of Object.entries(value)) {
    assertString(item, `${where}.${key}`);
  }
}

function assertTimeOfDay(value: unknown, where: string): void {
  assertString(value, where);
  const match = TIME_OF_DAY.exec(value as string);
  const hours = match ? Number(match[1]) : 24;
  const minutes = match ? Number(match[2]) : 60;
  if (!match || hours > 23 || minutes > 59) throw new Error(`${where} must be a time of day in HH:mm format`);
}

function assertHttpStatus(value: unknown, where: string): void {
  assertInteger(value, where, 100, 599);
}

function validateCondition(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error(`condition in ${label} must be an object`);
  unknownKeys(value, CONDITION_KEYS, `condition in ${label}`);
  if (value.if_step === undefined) throw new Error(`condition in ${label} requires an "if_step" field`);
  assertString(value.if_step, `condition.if_step in ${label}`);
  if (value.if_status !== undefined) assertHttpStatus(value.if_status, `condition.if_status in ${label}`);
  if (value.if_success !== undefined) assertBoolean(value.if_success, `condition.if_success in ${label}`);
}

function validateHttpExpect(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error(`expect in ${label} must be an object`);
  unknownKeys(value, HTTP_EXPECT_KEYS, `expect in ${label}`);

  if (value.status !== undefined) assertHttpStatus(value.status, `expect.status in ${label}`);
  if (value.status_in !== undefined) {
    if (!Array.isArray(value.status_in) || value.status_in.length === 0) {
      throw new Error(`expect.status_in in ${label} must be a non-empty array of HTTP status codes`);
    }
    value.status_in.forEach((code, index) => assertHttpStatus(code, `expect.status_in[${index}] in ${label}`));
  }
  for (const key of ['body_contains', 'body_matches', 'header_contains', 'header_matches', 'json_path'] as const) {
    if (value[key] !== undefined) assertString(value[key], `expect.${key} in ${label}`);
  }
  if (value.response_time_under !== undefined) {
    assertNumber(value.response_time_under, `expect.response_time_under in ${label}`, 0);
  }
  if (value.body_schema !== undefined) validateBodySchema(value.body_schema, `expect.body_schema in ${label}`);
}

function validateBrowserExpect(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error(`expect in ${label} must be an object`);
  unknownKeys(value, BROWSER_EXPECT_KEYS, `expect in ${label}`);

  for (const key of ['has_text', 'not_has_text', 'url_contains'] as const) {
    if (value[key] !== undefined) assertString(value[key], `expect.${key} in ${label}`);
  }
  if (value.selector_count !== undefined) {
    assertInteger(value.selector_count, `expect.selector_count in ${label}`, 0);
  }
}

function validateBodySchema(value: unknown, where: string): void {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  unknownKeys(value, SCHEMA_KEYS, where);

  if (value.type !== undefined) {
    if (typeof value.type !== 'string' || !SCHEMA_TYPES.includes(value.type as typeof SCHEMA_TYPES[number])) {
      throw new Error(`${where}: unknown type "${String(value.type)}" (expected one of: ${SCHEMA_TYPES.join(', ')})`);
    }
  }
  if (value.required !== undefined) assertStringArray(value.required, `${where}.required`);
  if (value.properties !== undefined) {
    if (!isObject(value.properties)) throw new Error(`${where}.properties must be an object`);
    for (const [key, schema] of Object.entries(value.properties)) {
      validateBodySchema(schema, `${where}.properties.${key}`);
    }
  }
  if (value.items !== undefined) validateBodySchema(value.items, `${where}.items`);

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      throw new Error(`${where}.enum must be a non-empty array`);
    }
  }
  if (value.pattern !== undefined) {
    assertString(value.pattern, `${where}.pattern`);
    try {
      new RegExp(value.pattern as string);
    } catch {
      throw new Error(`${where}.pattern is not a valid regular expression`);
    }
    if (value.type !== undefined && value.type !== 'string') {
      throw new Error(`${where}.pattern requires type "string"`);
    }
  }
  if (value.min !== undefined) assertNumber(value.min, `${where}.min`);
  if (value.max !== undefined) assertNumber(value.max, `${where}.max`);
  if (
    (value.min !== undefined || value.max !== undefined)
    && value.type !== undefined
    && value.type !== 'number'
  ) {
    throw new Error(`${where}.min/max require type "number"`);
  }
  if (typeof value.min === 'number' && typeof value.max === 'number' && value.min > value.max) {
    throw new Error(`${where}.min must not be greater than ${where}.max`);
  }
  if (value.nullable !== undefined) assertBoolean(value.nullable, `${where}.nullable`);

  for (const key of ['title', 'description'] as const) {
    if (value[key] !== undefined) assertString(value[key], `${where}.${key}`, true);
  }
}

function validateStep(value: unknown, index: number): void {
  if (!isObject(value)) throw new Error(`Step ${index} must be an object`);

  const label = typeof value.name === 'string' && value.name !== ''
    ? `step "${value.name}"`
    : `step ${index}`;

  if (value.include !== undefined) {
    unknownKeys(value, INCLUDE_KEYS, label);
    assertString(value.include, `${label}.include`);
    if (value.name !== undefined) assertString(value.name, `${label}.name`);
    return;
  }

  if (value.action === undefined) throw new Error(`${label} must have an "action" field`);
  assertString(value.action, `${label}.action`);
  const action = value.action as string;
  const isHttp = (HTTP_ACTIONS as readonly string[]).includes(action);
  const isBrowser = (BROWSER_ACTIONS as readonly string[]).includes(action);
  if (!isHttp && !isBrowser) throw new Error(`Unknown action type "${action}" in ${label}`);

  unknownKeys(value, isHttp ? HTTP_KEYS : BROWSER_KEYS, label);

  if (value.name !== undefined) assertString(value.name, `${label}.name`);
  if (value.timeout !== undefined) assertNumber(value.timeout, `${label}.timeout`, 1);
  if (value.condition !== undefined) validateCondition(value.condition, label);
  if (value.variables !== undefined) assertStringRecord(value.variables, `${label}.variables`);
  if (value.headers !== undefined && isHttp) assertStringRecord(value.headers, `${label}.headers`);
  if (value.expect !== undefined) {
    if (isHttp) validateHttpExpect(value.expect, label);
    else validateBrowserExpect(value.expect, label);
  }

  if (isHttp) {
    if (value.url === undefined) throw new Error(`${label} (${action}) requires a "url" field`);
    assertString(value.url, `${label}.url`);
    return;
  }

  switch (action) {
    case 'browser.navigate':
      if (value.url === undefined) throw new Error(`${label} (${action}) requires a "url" field`);
      assertString(value.url, `${label}.url`);
      break;
    case 'browser.fill':
    case 'browser.type':
    case 'browser.select':
      requireSelector(value, label, action);
      if (value.value === undefined) throw new Error(`${label} (${action}) requires a "value" field`);
      assertString(value.value, `${label}.value`, true);
      break;
    case 'browser.click':
    case 'browser.check':
    case 'browser.uncheck':
    case 'browser.wait_for':
      requireSelector(value, label, action);
      break;
    case 'browser.evaluate':
      if (value.script === undefined) throw new Error(`${label} (${action}) requires a "script" field`);
      assertString(value.script, `${label}.script`);
      break;
    case 'browser.scroll':
      if (value.value !== undefined) assertString(value.value, `${label}.value`);
      else if (value.selector !== undefined) assertString(value.selector, `${label}.selector`);
      else throw new Error(`${label} (${action}) requires a "value" or "selector" field`);
      break;
    default:
      // browser.screenshot / browser.screenshot_compare take optional paths.
      break;
  }
}

function requireSelector(value: Record<string, unknown>, label: string, action: string): void {
  if (value.selector === undefined) throw new Error(`${label} (${action}) requires a "selector" field`);
  assertString(value.selector, `${label}.selector`);
}

// Throws a descriptive error for the first invalid scenario field, step, or expectation.
export function validateScenario(raw: Record<string, unknown>): void {
  unknownKeys(raw, SCENARIO_KEYS, 'scenario');

  if (raw.name === undefined) throw new Error('Scenario must have a "name" field');
  assertString(raw.name, 'scenario.name');

  if (raw.steps === undefined || !Array.isArray(raw.steps)) {
    throw new Error('Scenario must have a "steps" array');
  }
  if (raw.steps.length === 0) throw new Error('Scenario must have at least one step');

  if (raw.description !== undefined) assertString(raw.description, 'scenario.description', true);
  if (raw.schedule !== undefined) {
    assertString(raw.schedule, 'scenario.schedule');
    if (!cron.validate(raw.schedule as string)) {
      throw new Error(`scenario.schedule "${raw.schedule}" is not a valid cron expression`);
    }
  }
  if (raw.base_url !== undefined) assertString(raw.base_url, 'scenario.base_url');
  if (raw.variables !== undefined) assertStringRecord(raw.variables, 'scenario.variables');
  if (raw.headers !== undefined) assertStringRecord(raw.headers, 'scenario.headers');
  if (raw.headless !== undefined) assertBoolean(raw.headless, 'scenario.headless');
  if (raw.ignoreHTTPSErrors !== undefined) assertBoolean(raw.ignoreHTTPSErrors, 'scenario.ignoreHTTPSErrors');
  if (raw.timeout !== undefined) assertNumber(raw.timeout, 'scenario.timeout', 1);
  if (raw.tags !== undefined) assertStringArray(raw.tags, 'scenario.tags');
  if (raw.depends_on !== undefined) assertString(raw.depends_on, 'scenario.depends_on');
  if (raw.group !== undefined) assertString(raw.group, 'scenario.group');

  if (raw.time_windows !== undefined) {
    if (!Array.isArray(raw.time_windows)) throw new Error('scenario.time_windows must be an array');
    raw.time_windows.forEach((window, index) => {
      const where = `scenario.time_windows[${index}]`;
      if (!isObject(window)) throw new Error(`${where} must be an object`);
      unknownKeys(window, TIME_WINDOW_KEYS, where);
      if (window.start === undefined) throw new Error(`${where} requires a "start" field`);
      if (window.end === undefined) throw new Error(`${where} requires an "end" field`);
      assertTimeOfDay(window.start, `${where}.start`);
      assertTimeOfDay(window.end, `${where}.end`);
      if (window.timezone !== undefined) assertString(window.timezone, `${where}.timezone`);
    });
  }

  if (raw.alert !== undefined) {
    if (!isObject(raw.alert)) throw new Error('scenario.alert must be an object');
    unknownKeys(raw.alert, ALERT_KEYS, 'scenario.alert');
    if (raw.alert.consecutive_failures !== undefined) {
      assertInteger(raw.alert.consecutive_failures, 'scenario.alert.consecutive_failures', 1);
    }
  }

  raw.steps.forEach((step, index) => validateStep(step, index));
}
