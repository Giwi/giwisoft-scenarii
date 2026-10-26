import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { Scenario, Step, HttpStep, BrowserStep, IncludeStep } from '../types';
import { validateScenario } from './validation';

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
    if (raw.headers !== undefined) step.headers = raw.headers as Record<string, string>;
    if (raw.body !== undefined) step.body = raw.body;
    if (raw.timeout !== undefined) step.timeout = raw.timeout as number;
    if (raw.condition) step.condition = raw.condition as HttpStep['condition'];
    if (raw.expect) step.expect = raw.expect as HttpStep['expect'];
    if (raw.variables !== undefined) step.variables = raw.variables as Record<string, string>;
    return step;
  }

  // Browser step — extract selector, value, script, timeout and expectations
  if (action.startsWith('browser.')) {
    const step: BrowserStep = {
      name,
      action: action as BrowserStep['action'],
    };
    if (raw.url !== undefined) step.url = raw.url as string;
    if (raw.selector !== undefined) step.selector = raw.selector as string;
    if (raw.value !== undefined) step.value = raw.value as string;
    if (raw.timeout) step.timeout = raw.timeout as number;
    if (raw.condition) step.condition = raw.condition as BrowserStep['condition'];
    if (raw.script !== undefined) step.script = raw.script as string;
    if (raw.expect) step.expect = raw.expect as BrowserStep['expect'];
    if (raw.variables !== undefined) step.variables = raw.variables as Record<string, string>;
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
  const raw = yaml.load(content);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid YAML: expected an object');
  }

  const data = raw as Record<string, unknown>;
  validateScenario(data);

  const scenario: Scenario = {
    name: data.name as string,
    steps: (data.steps as Record<string, unknown>[]).map((s, i) => parseStep(s, i)),
  };

  if (data.description) scenario.description = data.description as string;
  if (data.schedule) scenario.schedule = data.schedule as string;
  if (data.base_url) scenario.base_url = data.base_url as string;
  if (data.headless !== undefined) scenario.headless = data.headless as boolean;
  if (data.timeout !== undefined) scenario.timeout = data.timeout as number;
  if (data.ignoreHTTPSErrors !== undefined) scenario.ignoreHTTPSErrors = data.ignoreHTTPSErrors as boolean;
  if (data.tags && Array.isArray(data.tags)) scenario.tags = data.tags as string[];
  if (data.depends_on) scenario.depends_on = data.depends_on as string;
  if (data.group) scenario.group = data.group as string;
  if (data.time_windows && Array.isArray(data.time_windows)) scenario.time_windows = data.time_windows as Scenario['time_windows'];
  if (data.alert && typeof data.alert === 'object') scenario.alert = data.alert as Scenario['alert'];

  return scenario;
}

// Reads a YAML file from disk and parses it into a Scenario.
export function loadScenarioFile(filepath: string): Scenario {
  const content = fs.readFileSync(filepath, 'utf-8');
  return parseScenario(content);
}
