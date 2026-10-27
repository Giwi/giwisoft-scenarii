import { ScenarioMetrics } from '../../types';
import { StorageBackend, ScenarioInfo } from './types';
import { SqliteBackend } from './sqlite';
import { PostgresBackend } from './postgres';
import { getSettings } from '../settings';

export type { StorageBackend, ScenarioInfo, UserRow, ProfileRow } from './types';

let backend: StorageBackend | undefined;

// True when the value is a PostgreSQL connection string rather than a SQLite file path.
function isPostgresUrl(location: string): boolean {
  return /^postgres(ql)?:\/\//i.test(location);
}

// Resolves the storage location from an explicit argument, the DATABASE_URL env var,
// or the settings.yaml storage block, in that order of precedence.
function resolveStorageLocation(explicit?: string): string {
  if (explicit) return explicit;
  const envUrl = process.env.DATABASE_URL;
  if (envUrl) return envUrl;
  const s = getSettings().storage;
  if (s) {
    if (s.type === 'postgres' && s.url) return s.url;
    if (s.url && isPostgresUrl(s.url)) return s.url;
    if (s.type === 'sqlite' && s.path) return s.path;
  }
  return 'db/scenarii.db';
}

// Opens the configured storage backend (SQLite file or PostgreSQL) and creates its schema.
// Auto-detects the backend from a PostgreSQL connection URL prefix.
export async function initStorage(location?: string): Promise<void> {
  if (backend) throw new Error('Storage already initialized');
  const resolved = resolveStorageLocation(location);
  backend = isPostgresUrl(resolved) ? new PostgresBackend(resolved) : new SqliteBackend(resolved);
  await backend.init();
}

// Closes the backend connection gracefully.
export async function closeStorage(): Promise<void> {
  if (backend) {
    await backend.close();
    backend = undefined;
  }
}

// Returns true when the storage backend has been initialised.
export function isStorageReady(): boolean {
  return backend !== undefined;
}

// Returns the active backend. Used by the users module to reach the shared database.
export function getBackend(): StorageBackend {
  if (!backend) throw new Error('Database not initialized');
  return backend;
}

// ── Scenario run metrics (async public API) ──────────────────────────────────
export function createRun(scenarioName: string, startedAt: Date): Promise<number> {
  return getBackend().createRun(scenarioName, startedAt);
}

export function completeRun(runId: number, metrics: ScenarioMetrics): Promise<void> {
  return getBackend().completeRun(runId, metrics);
}

export function storeMetrics(metrics: ScenarioMetrics): Promise<number> {
  return getBackend().storeMetrics(metrics);
}

export function getRun(id: number): Promise<ScenarioMetrics | undefined> {
  return getBackend().getRun(id);
}

export function upsertScenarioTags(name: string, tags: string[]): Promise<void> {
  return getBackend().upsertScenarioTags(name, tags);
}

export function getScenarioList(tagFilter?: string): Promise<ScenarioInfo[]> {
  return getBackend().getScenarioList(tagFilter);
}

export function getScenarioHistory(name: string, limitDays = 7, limit = 50, offset = 0): Promise<ScenarioMetrics[]> {
  return getBackend().getScenarioHistory(name, limitDays, limit, offset);
}

export function getScenarioPassedRunCount(name: string, limitDays = 7): Promise<number> {
  return getBackend().getScenarioPassedRunCount(name, limitDays);
}

export function getScenarioHistoryCount(name: string, limitDays = 7): Promise<number> {
  return getBackend().getScenarioHistoryCount(name, limitDays);
}

export function getScenarioStepNames(name: string): Promise<string[]> {
  return getBackend().getScenarioStepNames(name);
}

export function getPreviousRunSuccess(name: string): Promise<boolean | null> {
  return getBackend().getPreviousRunSuccess(name);
}

export function getLastRunSuccess(name: string): Promise<boolean | null> {
  return getBackend().getLastRunSuccess(name);
}

export function purgeOldData(days = 7): Promise<number> {
  return getBackend().purgeOldData(days);
}

export function getDbScenarioTags(name: string): Promise<string[] | undefined> {
  return getBackend().getScenarioTags(name);
}

export function getDistinctTags(): Promise<string[]> {
  return getBackend().getDistinctTags();
}

export function backupDatabase(directory: string): Promise<string> {
  return getBackend().backup(directory);
}

// Fetches scenario info, paginated history, step names, and total run count in one call.
export async function getScenarioDetail(
  name: string,
  limitDays = 7,
  limit = 50,
  offset = 0,
): Promise<{ info: ScenarioInfo; history: ScenarioMetrics[]; stepNames: string[]; total: number }> {
  const list = await getScenarioList();
  const scenario = list.find(s => s.name === name);
  if (!scenario) throw new Error(`Scenario "${name}" not found in database`);
  const total = await getScenarioHistoryCount(name, limitDays);
  const history = await getScenarioHistory(name, limitDays, limit, offset);
  const stepNames = await getScenarioStepNames(name);
  return { info: scenario, history, stepNames, total };
}
