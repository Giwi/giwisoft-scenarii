import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { ScenarioMetrics, StepMetrics } from './types';
import logger from './logger';

let db: Database.Database | undefined;

export function initStorage(dbPath?: string): void {
  if (db) throw new Error('Storage already initialized');
  const resolved = dbPath || path.join(process.cwd(), 'db', 'scenarii.db');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  db = new Database(resolved);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scenario_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS step_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      action TEXT NOT NULL,
      success INTEGER NOT NULL,
      status_code INTEGER,
      response_time_ms INTEGER NOT NULL,
      error TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES scenario_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_name ON scenario_runs(scenario_name);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON scenario_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_step_run ON step_metrics(run_id);
  `);
}

export function storeMetrics(metrics: ScenarioMetrics): void {
  if (!db) throw new Error('Database not initialized');

  const insertRun = db.prepare(`
    INSERT INTO scenario_runs (scenario_name, started_at, finished_at, duration_ms, success, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertStep = db.prepare(`
    INSERT INTO step_metrics (run_id, step_name, action, success, status_code, response_time_ms, error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const result = insertRun.run(
      metrics.scenario_name,
      metrics.started_at.toISOString(),
      metrics.finished_at.toISOString(),
      metrics.duration_ms,
      metrics.success ? 1 : 0,
      now
    );
    const runId = result.lastInsertRowid as number;

    for (const step of metrics.steps) {
      insertStep.run(
        runId,
        step.step_name,
        step.action,
        step.success ? 1 : 0,
        step.status_code ?? null,
        step.response_time_ms,
        step.error ?? null,
        step.timestamp.toISOString()
      );
    }
  });

  transaction();
}

export function getScenarioList(): Array<{
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
}> {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(`
    SELECT
      r.scenario_name AS name,
      MAX(r.created_at) AS last_run,
      (
        SELECT success FROM scenario_runs
        WHERE scenario_name = r.scenario_name
        ORDER BY created_at DESC LIMIT 1
      ) AS last_success,
      (
        SELECT duration_ms FROM scenario_runs
        WHERE scenario_name = r.scenario_name
        ORDER BY created_at DESC LIMIT 1
      ) AS last_duration_ms,
      COUNT(*) AS total_runs
    FROM scenario_runs r
    GROUP BY r.scenario_name
    ORDER BY r.scenario_name
  `).all() as Array<{
    name: string;
    last_run: string | null;
    last_success: number | null;
    last_duration_ms: number | null;
    total_runs: number;
  }>;
}

export function getScenarioHistory(
  name: string,
  limitDays: number = 7,
  limit?: number,
  offset?: number
): ScenarioMetrics[] {
  if (!db) throw new Error('Database not initialized');

  const since = new Date(Date.now() - limitDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const queryLimit = limit ?? 50;
  const queryOffset = offset ?? 0;

  const rows = db.prepare(`
    SELECT
      r.id AS run_id,
      r.scenario_name,
      r.started_at,
      r.finished_at,
      r.duration_ms,
      r.success,
      r.created_at,
      s.id AS step_id,
      s.step_name,
      s.action,
      s.success AS step_success,
      s.status_code,
      s.response_time_ms,
      s.error,
      s.timestamp
    FROM (
      SELECT * FROM scenario_runs
      WHERE scenario_name = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    ) r
    LEFT JOIN step_metrics s ON s.run_id = r.id
    ORDER BY r.created_at DESC, s.id
  `).all(name, since, queryLimit, queryOffset) as Array<{
    run_id: number;
    scenario_name: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    success: number;
    created_at: string;
    step_id: number | null;
    step_name: string | null;
    action: string | null;
    step_success: number | null;
    status_code: number | null;
    response_time_ms: number | null;
    error: string | null;
    timestamp: string | null;
  }>;

  const runMap = new Map<number, ScenarioMetrics>();
  for (const row of rows) {
    if (!runMap.has(row.run_id)) {
      runMap.set(row.run_id, {
        scenario_name: row.scenario_name,
        started_at: new Date(row.started_at),
        finished_at: new Date(row.finished_at),
        duration_ms: row.duration_ms,
        success: row.success === 1,
        steps: [],
      });
    }
    if (row.step_id !== null) {
      const run = runMap.get(row.run_id)!;
      run.steps.push({
        step_name: row.step_name!,
        action: row.action!,
        success: row.step_success === 1,
        status_code: row.status_code ?? undefined,
        response_time_ms: row.response_time_ms!,
        error: row.error ?? undefined,
        timestamp: new Date(row.timestamp!),
      });
    }
  }
  return Array.from(runMap.values());
}

export function getScenarioHistoryCount(name: string, limitDays: number = 7): number {
  if (!db) throw new Error('Database not initialized');
  const since = new Date(Date.now() - limitDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM scenario_runs
    WHERE scenario_name = ? AND created_at >= ?
  `).get(name, since) as { count: number };
  return row.count;
}

export function getScenarioDetail(
  name: string,
  limitDays: number = 7,
  limit: number = 50,
  offset: number = 0
): { info: any; history: ScenarioMetrics[]; stepNames: string[]; total: number } {
  if (!db) throw new Error('Database not initialized');
  const list = getScenarioList();
  const scenario = list.find((s) => s.name === name);
  if (!scenario) throw new Error(`Scenario "${name}" not found in database`);
  const total = getScenarioHistoryCount(name, limitDays);
  const history = getScenarioHistory(name, limitDays, limit, offset);
  const stepNames = getScenarioStepNames(name);
  return { info: scenario, history, stepNames, total };
}

export function getScenarioStepNames(name: string): string[] {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(`
    SELECT DISTINCT step_name FROM step_metrics s
    JOIN scenario_runs r ON s.run_id = r.id
    WHERE r.scenario_name = ?
    ORDER BY step_name
  `).pluck().all(name) as string[];
}

export function getPreviousRunSuccess(scenarioName: string): boolean | null {
  if (!db) throw new Error('Database not initialized');
  const row = db.prepare(`
    SELECT success FROM scenario_runs
    WHERE scenario_name = ?
    ORDER BY created_at DESC
    LIMIT 1 OFFSET 1
  `).get(scenarioName) as { success: number } | undefined;
  return row ? row.success === 1 : null;
}

export function purgeOldData(days: number = 7): number {
  if (!db) throw new Error('Database not initialized');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const result = db.prepare(`DELETE FROM scenario_runs WHERE created_at < ?`).run(since);
  return result.changes;
}

export function closeStorage(): void {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      logger.error({ err }, 'Error closing database');
    }
    db = undefined;
  }
}

export function isStorageReady(): boolean {
  return db !== undefined;
}
