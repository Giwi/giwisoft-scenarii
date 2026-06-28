import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { Scenario, Step, HttpStep, BrowserStep, IncludeStep } from './types';

// Parses a single step object from raw YAML data, dispatching by action prefix.
function parseStep(raw: Record<string, unknown>, index: number): Step {
  // Include step — references steps from another scenario
  if (raw.include) {
    const step: IncludeStep = { include: raw.include as string };
    if (raw.name) step.name = raw.name as string;
    return step;
  }

  const name = (raw.name as string) || `step_${index}`;
  const action = raw.action as string;

  // HTTP step — extract URL, headers, body, expectations and variables
  if (action.startsWith('http.')) {
    const step: HttpStep = {
      name,
      action: action as HttpStep['action'],
      url: raw.url as string,
    };
    if (raw.headers) step.headers = raw.headers as Record<string, string>;
    if (raw.body !== undefined) step.body = raw.body;
    if (raw.expect) step.expect = raw.expect as HttpStep['expect'];
    if (raw.variables) step.variables = raw.variables as Record<string, string>;
    return step;
  }

  // Browser step — extract selector, value, script, timeout and expectations
  if (action.startsWith('browser.')) {
    const step: BrowserStep = {
      name,
      action: action as BrowserStep['action'],
    };
    if (raw.url) step.url = raw.url as string;
    if (raw.selector) step.selector = raw.selector as string;
    if (raw.value) step.value = raw.value as string;
    if (raw.timeout) step.timeout = raw.timeout as number;
    if (raw.script) step.script = raw.script as string;
    if (raw.expect) step.expect = raw.expect as BrowserStep['expect'];
    return step;
  }

  throw new Error(`Unknown action type: ${action} in step "${name}"`);
}

// Recursively resolves include steps by loading the referenced YAML files
export function resolveIncludes(scenario: Scenario, scenariosDir: string, visited: Set<string> = new Set()): Step[] {
  const steps: Step[] = [];

  for (const step of scenario.steps) {
    if ('include' in step) {
      const inc = step as IncludeStep;
      // Find the referenced scenario file
      const includeName = inc.include.replace(/\.ya?ml$/, '');
      if (visited.has(includeName)) {
        throw new Error(`Circular include detected: ${includeName}`);
      }
      visited.add(includeName);

      // Look for a matching file in the scenarios directory
      const files = fs.readdirSync(scenariosDir).filter(f =>
        f.endsWith('.yml') || f.endsWith('.yaml')
      );

      let found = false;
      for (const file of files) {
        const filePath = path.join(scenariosDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const includedScenario = parseScenario(content);
        if (includedScenario.name === includeName || file.replace(/\.ya?ml$/, '') === includeName) {
          const resolved = resolveIncludes(includedScenario, scenariosDir, visited);
          // Optionally prefix step names with the include reference name
          for (const s of resolved) {
            if (inc.name && 'name' in s) {
              (s as any).name = `${inc.name}: ${(s as any).name}`;
            }
          }
          steps.push(...resolved);
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(`Included scenario not found: ${inc.include}`);
      }

      visited.delete(includeName);
    } else {
      steps.push(step);
    }
  }

  return steps;
}

// Parses a YAML string into a Scenario object, validating required fields.
export function parseScenario(content: string): Scenario {
  const raw = yaml.load(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid YAML: expected an object');
  }

  if (!raw.name) {
    throw new Error('Scenario must have a "name" field');
  }

  if (!raw.steps || !Array.isArray(raw.steps)) {
    throw new Error('Scenario must have a "steps" array');
  }

  const scenario: Scenario = {
    name: raw.name as string,
    steps: (raw.steps as Record<string, unknown>[]).map((s, i) => parseStep(s, i)),
  };

  if (raw.description) scenario.description = raw.description as string;
  if (raw.schedule) scenario.schedule = raw.schedule as string;
  if (raw.base_url) scenario.base_url = raw.base_url as string;
  if (raw.headless !== undefined) scenario.headless = raw.headless as boolean;
  if (raw.timeout !== undefined) scenario.timeout = raw.timeout as number;
  if (raw.ignoreHTTPSErrors !== undefined) scenario.ignoreHTTPSErrors = raw.ignoreHTTPSErrors as boolean;
  if (raw.tags && Array.isArray(raw.tags)) scenario.tags = raw.tags as string[];
  if (raw.depends_on) scenario.depends_on = raw.depends_on as string;
  if (raw.alert && typeof raw.alert === 'object') scenario.alert = raw.alert as Scenario['alert'];

  return scenario;
}

// Reads a YAML file from disk and parses it into a Scenario.
export function loadScenarioFile(filepath: string): Scenario {
  const content = fs.readFileSync(filepath, 'utf-8');
  return parseScenario(content);
}

// Serialises a Scenario object back into YAML, preserving optional fields.
export function serializeScenario(scenario: Scenario): string {
  const obj: Record<string, unknown> = {
    name: scenario.name,
    steps: scenario.steps.map(s => {
      if ('include' in s) {
        const step: Record<string, unknown> = { include: s.include };
        if (s.name) step.name = s.name;
        return step;
      }
      const step: Record<string, unknown> = { name: s.name, action: s.action };
      if ('url' in s && s.url) step.url = s.url;
      if ('selector' in s && s.selector) step.selector = s.selector;
      if ('value' in s && s.value) step.value = s.value;
      if ('timeout' in s && s.timeout) step.timeout = s.timeout;
      if ('script' in s && s.script) step.script = s.script;
      if ('headers' in s && s.headers) step.headers = s.headers;
      if ('body' in s && s.body) step.body = s.body;
      if ('expect' in s && s.expect) step.expect = s.expect;
      if ('variables' in s && s.variables) step.variables = s.variables;
      if ('condition' in s && s.condition) step.condition = s.condition;
      return step;
    }),
  };
  if (scenario.description) obj.description = scenario.description;
  if (scenario.schedule) obj.schedule = scenario.schedule;
  if (scenario.base_url) obj.base_url = scenario.base_url;
  if (scenario.timeout) obj.timeout = scenario.timeout;
  if (scenario.tags) obj.tags = scenario.tags;
  if (scenario.depends_on) obj.depends_on = scenario.depends_on;
  if (scenario.alert) obj.alert = scenario.alert;
  return require('js-yaml').dump(obj, { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false });
}
