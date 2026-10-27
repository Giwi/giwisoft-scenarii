import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { ScenarioMetrics } from '../../types';
import { StorageBackend, ScenarioInfo, UserRow, ProfileRow, PasswordResetRow, HistoryRow } from './types';
import { collapseHistory, daysAgo, parseTags, sqlNow } from './shared';

const PROFILE_COLUMNS: [string, string][] = [
  ['email', 'TEXT'],
  ['avatar', 'BLOB'],
  ['avatar_mime', 'TEXT'],
  ['lang', "TEXT NOT NULL DEFAULT 'en'"],
  ['color_scheme', "TEXT NOT NULL DEFAULT 'light'"],
  ['totp_secret', 'TEXT'],
  ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['totp_recovery', 'TEXT'],
];

// SQLite backend using better-sqlite3. Synchronous under the hood; wrapped in async
// methods to satisfy the StorageBackend contract shared with PostgreSQL.
export class SqliteBackend implements StorageBackend {
  readonly type = 'sqlite' as const;
  private db: Database.Database | undefined;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.db) throw new Error('Storage already initialized');
    const resolved = this.filePath === ':memory:' ? ':memory:' : path.resolve(this.filePath);
    if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    this.db = db;

    db.exec(`
      CREATE TABLE IF NOT EXISTS scenario_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        flaky INTEGER NOT NULL DEFAULT 0,
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
        attempts INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        timestamp TEXT NOT NULL,
        request_url TEXT,
        request_method TEXT,
        request_headers TEXT,
        request_body TEXT,
        response_headers TEXT,
        response_body TEXT,
        FOREIGN KEY (run_id) REFERENCES scenario_runs(id)
      );
      CREATE TABLE IF NOT EXISTS scenario_tags (
        scenario_name TEXT PRIMARY KEY,
        tags TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        email TEXT,
        avatar BLOB,
        avatar_mime TEXT,
        lang TEXT NOT NULL DEFAULT 'en',
        color_scheme TEXT NOT NULL DEFAULT 'light',
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        totp_recovery TEXT
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_name ON scenario_runs(scenario_name);
      CREATE INDEX IF NOT EXISTS idx_runs_created ON scenario_runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_step_run ON step_metrics(run_id);
    `);

    this.migrate();
  }

  // Brings older databases up to date by adding columns introduced after the initial
  // schema, preserving existing installs.
  private migrate(): void {
    const db = this.db!;
    const runColumns = (db.prepare('PRAGMA table_info(scenario_runs)').all() as { name: string }[]).map(c => c.name);
    if (!runColumns.includes('flaky')) {
      db.exec('ALTER TABLE scenario_runs ADD COLUMN flaky INTEGER NOT NULL DEFAULT 0');
    }
    const stepColumns = (db.prepare('PRAGMA table_info(step_metrics)').all() as { name: string }[]).map(c => c.name);
    if (!stepColumns.includes('attempts')) {
      db.exec('ALTER TABLE step_metrics ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');
    }
    const addCol = (name: string, def: string) => {
      if (!stepColumns.includes(name)) db.exec(`ALTER TABLE step_metrics ADD COLUMN ${name} ${def}`);
    };
    addCol('request_url', 'TEXT');
    addCol('request_method', 'TEXT');
    addCol('request_headers', 'TEXT');
    addCol('request_body', 'TEXT');
    addCol('response_headers', 'TEXT');
    addCol('response_body', 'TEXT');
    const userColumns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
    if (!userColumns.includes('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
      const oldest = db.prepare('SELECT username FROM users ORDER BY created_at LIMIT 1').get() as { username: string } | undefined;
      if (oldest) db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(oldest.username);
    }
    for (const [name, definition] of PROFILE_COLUMNS) {
      if (!userColumns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
  }

  private get handle(): Database.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  async close(): Promise<void> {
    if (this.db) {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.close(); } catch { /* ignore */ }
      this.db = undefined;
    }
  }

  // ── Scenario runs ──────────────────────────────────────────────────────────
  async storeMetrics(metrics: ScenarioMetrics): Promise<void> {
    const db = this.handle;
    const insertRun = db.prepare(`
      INSERT INTO scenario_runs (scenario_name, started_at, finished_at, duration_ms, success, flaky, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertStep = db.prepare(`
      INSERT INTO step_metrics (run_id, step_name, action, success, status_code, response_time_ms, attempts, error, timestamp, request_url, request_method, request_headers, request_body, response_headers, response_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      const result = insertRun.run(
        metrics.scenario_name,
        metrics.started_at.toISOString(),
        metrics.finished_at.toISOString(),
        metrics.duration_ms,
        metrics.success ? 1 : 0,
        metrics.flaky ? 1 : 0,
        sqlNow(),
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
          step.attempts ?? 1,
          step.error ?? null,
          step.timestamp.toISOString(),
          step.request_url ?? null,
          step.request_method ?? null,
          step.request_headers ? JSON.stringify(step.request_headers) : null,
          step.request_body ?? null,
          step.response_headers ? JSON.stringify(step.response_headers) : null,
          step.response_body ?? null,
        );
      }
    });
    tx();
  }

  async upsertScenarioTags(name: string, tags: string[]): Promise<void> {
    this.handle.prepare(`
      INSERT INTO scenario_tags (scenario_name, tags) VALUES (?, ?)
      ON CONFLICT(scenario_name) DO UPDATE SET tags = excluded.tags
    `).run(name, JSON.stringify(tags));
  }

  async getScenarioList(tagFilter?: string): Promise<ScenarioInfo[]> {
    const db = this.handle;
    const rows = db.prepare(`
      SELECT
        r.scenario_name AS name,
        MAX(r.created_at) AS last_run,
        (SELECT sr2.success FROM scenario_runs sr2 WHERE sr2.scenario_name = r.scenario_name ORDER BY sr2.created_at DESC, sr2.id DESC LIMIT 1) AS last_success,
        (SELECT sr3.duration_ms FROM scenario_runs sr3 WHERE sr3.scenario_name = r.scenario_name ORDER BY sr3.created_at DESC, sr3.id DESC LIMIT 1) AS last_duration_ms,
        COUNT(*) AS total_runs
      FROM scenario_runs r
      WHERE (? IS NULL OR r.scenario_name IN (SELECT scenario_name FROM scenario_tags WHERE tags LIKE ?))
      GROUP BY r.scenario_name
      ORDER BY r.scenario_name
    `).all(tagFilter ? `%"${tagFilter}"%` : null, tagFilter ? `%"${tagFilter}"%` : null) as Array<{
      name: string; last_run: string; last_success: number | null; last_duration_ms: number | null; total_runs: number;
    }>;

    const tagRows = db.prepare('SELECT scenario_name, tags FROM scenario_tags').all() as { scenario_name: string; tags: string }[];
    const tagMap = new Map(tagRows.map(t => [t.scenario_name, parseTags(t.tags)]));
    return rows.map(r => ({ ...r, tags: tagMap.get(r.name) }));
  }

  async getScenarioHistory(name: string, limitDays: number, limit: number, offset: number): Promise<ScenarioMetrics[]> {
    const since = daysAgo(limitDays);
    const rows = this.handle.prepare(`
      SELECT
        r.id AS run_id, r.scenario_name, r.started_at, r.finished_at, r.duration_ms, r.success, r.flaky, r.created_at,
        s.id AS step_id, s.step_name, s.action, s.success AS step_success, s.status_code, s.response_time_ms, s.attempts, s.error, s.timestamp,
        s.request_url, s.request_method, s.request_headers, s.request_body, s.response_headers, s.response_body
      FROM (
        SELECT * FROM scenario_runs
        WHERE scenario_name = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      ) r
      LEFT JOIN step_metrics s ON s.run_id = r.id
      ORDER BY r.created_at DESC, s.id
    `).all(name, since, limit, offset) as HistoryRow[];
    return collapseHistory(rows);
  }

  async getScenarioPassedRunCount(name: string, limitDays: number): Promise<number> {
    const row = this.handle.prepare(`
      SELECT COUNT(*) AS count FROM scenario_runs WHERE scenario_name = ? AND created_at >= ? AND success = 1
    `).get(name, daysAgo(limitDays)) as { count: number };
    return row.count;
  }

  async getScenarioHistoryCount(name: string, limitDays: number): Promise<number> {
    const row = this.handle.prepare(`
      SELECT COUNT(*) AS count FROM scenario_runs WHERE scenario_name = ? AND created_at >= ?
    `).get(name, daysAgo(limitDays)) as { count: number };
    return row.count;
  }

  async getScenarioStepNames(name: string): Promise<string[]> {
    return this.handle.prepare(`
      SELECT DISTINCT step_name FROM step_metrics s
      JOIN scenario_runs r ON s.run_id = r.id
      WHERE r.scenario_name = ?
      ORDER BY step_name
    `).pluck().all(name) as string[];
  }

  async getPreviousRunSuccess(name: string): Promise<boolean | null> {
    const row = this.handle.prepare(`
      SELECT success FROM scenario_runs WHERE scenario_name = ? ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 1
    `).get(name) as { success: number } | undefined;
    return row ? row.success === 1 : null;
  }

  async getLastRunSuccess(name: string): Promise<boolean | null> {
    const row = this.handle.prepare(`
      SELECT success FROM scenario_runs WHERE scenario_name = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(name) as { success: number } | undefined;
    return row ? row.success === 1 : null;
  }

  async purgeOldData(days: number): Promise<number> {
    const result = this.handle.prepare('DELETE FROM scenario_runs WHERE created_at < ?').run(daysAgo(days));
    return result.changes;
  }

  async getScenarioTags(name: string): Promise<string[] | undefined> {
    const row = this.handle.prepare('SELECT tags FROM scenario_tags WHERE scenario_name = ?').get(name) as { tags: string } | undefined;
    return row ? parseTags(row.tags) : undefined;
  }

  async getDistinctTags(): Promise<string[]> {
    const rows = this.handle.prepare('SELECT DISTINCT tags FROM scenario_tags').all() as { tags: string }[];
    const set = new Set<string>();
    for (const row of rows) {
      const parsed = parseTags(row.tags);
      for (const t of parsed ?? []) set.add(t);
    }
    return [...set].sort();
  }

  async backup(directory: string): Promise<string> {
    const db = this.handle;
    const src = db.name;
    if (src === ':memory:') throw new Error('Cannot back up an in-memory database');
    fs.mkdirSync(directory, { recursive: true });
    db.pragma('wal_checkpoint(TRUNCATE)');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(directory, `scenarii-${timestamp}.db`);
    fs.copyFileSync(src, dest);
    return dest;
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  async getUser(username: string): Promise<UserRow | undefined> {
    const row = this.handle.prepare('SELECT username, role, created_at FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return row;
  }

  async listUsers(): Promise<UserRow[]> {
    return this.handle.prepare('SELECT username, role, created_at FROM users ORDER BY username').all() as UserRow[];
  }

  async countUsers(): Promise<number> {
    return (this.handle.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  }

  async insertUser(username: string, passwordHash: string, role: string, createdAt: string): Promise<boolean> {
    const res = this.handle.prepare('INSERT OR IGNORE INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, role, createdAt);
    return res.changes > 0;
  }

  async setUserPassword(username: string, passwordHash: string): Promise<boolean> {
    return this.handle.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(passwordHash, username).changes > 0;
  }

  async getPasswordHash(username: string): Promise<string | undefined> {
    return (this.handle.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as { password_hash: string } | undefined)?.password_hash;
  }

  async setUserRole(username: string, role: string): Promise<boolean> {
    return this.handle.prepare('UPDATE users SET role = ? WHERE username = ?').run(role, username).changes > 0;
  }

  async deleteUser(username: string): Promise<boolean> {
    return this.handle.prepare('DELETE FROM users WHERE username = ?').run(username).changes > 0;
  }

  async getProfile(username: string): Promise<ProfileRow | undefined> {
    return this.handle.prepare('SELECT email, avatar, lang, color_scheme, totp_enabled FROM users WHERE username = ?').get(username) as ProfileRow | undefined;
  }

  async updateProfile(username: string, email: string | null, lang: string, colorScheme: string): Promise<void> {
    this.handle.prepare('UPDATE users SET email = ?, lang = ?, color_scheme = ? WHERE username = ?').run(email, lang, colorScheme, username);
  }

  async getAvatar(username: string): Promise<{ mime: string; bytes: Buffer } | undefined> {
    const row = this.handle.prepare('SELECT avatar, avatar_mime FROM users WHERE username = ?').get(username) as
      { avatar: Buffer | null; avatar_mime: string | null } | undefined;
    if (!row?.avatar?.length) return undefined;
    return { mime: row.avatar_mime || 'image/png', bytes: Buffer.from(row.avatar) };
  }

  async setAvatar(username: string, mime: string, bytes: Buffer): Promise<void> {
    this.handle.prepare('UPDATE users SET avatar = ?, avatar_mime = ? WHERE username = ?').run(bytes, mime, username);
  }

  async deleteAvatar(username: string): Promise<void> {
    this.handle.prepare('UPDATE users SET avatar = NULL, avatar_mime = NULL WHERE username = ?').run(username);
  }

  async setTotpSecret(username: string, secret: string | null, recoveryJson: string | null): Promise<void> {
    this.handle.prepare('UPDATE users SET totp_secret = ?, totp_recovery = ? WHERE username = ?').run(secret, recoveryJson, username);
  }

  async enableTotp(username: string, secret: string, recoveryJson: string): Promise<boolean> {
    return this.handle.prepare('UPDATE users SET totp_secret = ?, totp_recovery = ?, totp_enabled = 1 WHERE username = ?')
      .run(secret, recoveryJson, username).changes > 0;
  }

  async disableTotp(username: string): Promise<boolean> {
    return this.handle.prepare('UPDATE users SET totp_secret = NULL, totp_recovery = NULL, totp_enabled = 0 WHERE username = ?').run(username).changes > 0;
  }

  async getTotpSecret(username: string): Promise<string | undefined> {
    return (this.handle.prepare('SELECT totp_secret FROM users WHERE username = ?').get(username) as { totp_secret: string | null } | undefined)?.totp_secret || undefined;
  }

  async getRecoveryCodes(username: string): Promise<string[]> {
    const row = this.handle.prepare('SELECT totp_recovery FROM users WHERE username = ?').get(username) as { totp_recovery: string | null } | undefined;
    if (!row?.totp_recovery) return [];
    try { return JSON.parse(row.totp_recovery) as string[]; } catch { return []; }
  }

  async setRecoveryCodes(username: string, recoveryJson: string): Promise<void> {
    this.handle.prepare('UPDATE users SET totp_recovery = ? WHERE username = ?').run(recoveryJson, username);
  }

  async deletePasswordResets(username: string): Promise<void> {
    this.handle.prepare('DELETE FROM password_resets WHERE username = ?').run(username);
  }

  async insertPasswordReset(username: string, tokenHash: string, expiresAt: string, createdAt: string): Promise<void> {
    this.handle.prepare('INSERT INTO password_resets (token_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, username, expiresAt, createdAt);
  }

  async getPasswordReset(tokenHash: string): Promise<PasswordResetRow | undefined> {
    return this.handle.prepare('SELECT username, expires_at FROM password_resets WHERE token_hash = ?').get(tokenHash) as PasswordResetRow | undefined;
  }

  async deletePasswordReset(tokenHash: string): Promise<void> {
    this.handle.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(tokenHash);
  }

  async prunePasswordResets(now: string): Promise<void> {
    this.handle.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now);
  }

  async findUserByIdentifier(needle: string): Promise<string | undefined> {
    const wanted = needle.toLowerCase();
    const row = this.handle.prepare('SELECT username FROM users WHERE lower(username) = ? OR lower(email) = ?').get(wanted, wanted) as
      { username: string } | undefined;
    return row?.username;
  }
}
