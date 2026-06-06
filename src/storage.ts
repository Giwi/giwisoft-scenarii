import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { ScenarioMetrics, StepMetrics } from './types';

let db: Database.Database;

export function initStorage(dbPath?: string): void {
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
  limitDays: number = 7
): ScenarioMetrics[] {
  if (!db) throw new Error('Database not initialized');

  const since = new Date(Date.now() - limitDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  const runs = db.prepare(`
    SELECT * FROM scenario_runs
    WHERE scenario_name = ? AND created_at >= ?
    ORDER BY created_at DESC
  `).all(name, since) as Array<{
    id: number;
    scenario_name: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    success: number;
    created_at: string;
  }>;

  const getSteps = db.prepare(`
    SELECT * FROM step_metrics
    WHERE run_id = ?
    ORDER BY id
  `);

  return runs.map((run) => {
    const steps = getSteps.all(run.id) as Array<{
      step_name: string;
      action: string;
      success: number;
      status_code: number | null;
      response_time_ms: number;
      error: string | null;
      timestamp: string;
    }>;

    return {
      scenario_name: run.scenario_name,
      started_at: new Date(run.started_at),
      finished_at: new Date(run.finished_at),
      duration_ms: run.duration_ms,
      success: run.success === 1,
      steps: steps.map((s) => ({
        step_name: s.step_name,
        action: s.action,
        success: s.success === 1,
        status_code: s.status_code ?? undefined,
        response_time_ms: s.response_time_ms,
        error: s.error ?? undefined,
        timestamp: new Date(s.timestamp),
      })),
    };
  });
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

export function purgeOldData(days: number = 7): number {
  if (!db) throw new Error('Database not initialized');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const result = db.prepare(`DELETE FROM scenario_runs WHERE created_at < ?`).run(since);
  return result.changes;
}

export function closeStorage(): void {
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

export function isStorageReady(): boolean {
  return db !== undefined && db !== null;
}
