import { Pool } from 'pg';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ScenarioMetrics } from '../../types';
import { StorageBackend, ScenarioInfo, UserRow, ProfileRow, PasswordResetRow, HistoryRow } from './types';
import { collapseHistory, daysAgo, parseTags, sqlNow } from './shared';

// PostgreSQL backend using node-postgres. All operations are async; timestamps are
// stored as sortable TEXT (UTC) to keep parity with the SQLite schema and simplify
// cross-backend behaviour.
export class PostgresBackend implements StorageBackend {
  readonly type = 'postgres' as const;
  private pool: Pool | undefined;

  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    if (this.pool) throw new Error('Storage already initialized');
    const pool = new Pool({ connectionString: this.connectionString, max: 10 });
    this.pool = pool;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scenario_runs (
        id BIGSERIAL PRIMARY KEY,
        scenario_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        flaky INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS step_metrics (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
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
        response_body TEXT
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
        avatar BYTEA,
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
  }

  private get handle(): Pool {
    if (!this.pool) throw new Error('Database not initialized');
    return this.pool;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = undefined;
    }
  }

  // ── Scenario runs ──────────────────────────────────────────────────────────
  async storeMetrics(metrics: ScenarioMetrics): Promise<void> {
    const client = await this.handle.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO scenario_runs (scenario_name, started_at, finished_at, duration_ms, success, flaky, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          metrics.scenario_name,
          metrics.started_at.toISOString(),
          metrics.finished_at.toISOString(),
          metrics.duration_ms,
          metrics.success ? 1 : 0,
          metrics.flaky ? 1 : 0,
          sqlNow(),
        ],
      );
      const runId = res.rows[0].id as string | number;
      for (const step of metrics.steps) {
        await client.query(
          `INSERT INTO step_metrics (run_id, step_name, action, success, status_code, response_time_ms, attempts, error, timestamp, request_url, request_method, request_headers, request_body, response_headers, response_body)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
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
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertScenarioTags(name: string, tags: string[]): Promise<void> {
    await this.handle.query(
      `INSERT INTO scenario_tags (scenario_name, tags) VALUES ($1, $2)
       ON CONFLICT (scenario_name) DO UPDATE SET tags = EXCLUDED.tags`,
      [name, JSON.stringify(tags)],
    );
  }

  async getScenarioList(tagFilter?: string): Promise<ScenarioInfo[]> {
    const pool = this.handle;
    const base = `
      SELECT
        r.scenario_name AS name,
        MAX(r.created_at) AS last_run,
        (SELECT sr2.success FROM scenario_runs sr2 WHERE sr2.scenario_name = r.scenario_name ORDER BY sr2.created_at DESC, sr2.id DESC LIMIT 1) AS last_success,
        (SELECT sr3.duration_ms FROM scenario_runs sr3 WHERE sr3.scenario_name = r.scenario_name ORDER BY sr3.created_at DESC, sr3.id DESC LIMIT 1) AS last_duration_ms,
        COUNT(*) AS total_runs
      FROM scenario_runs r`;
    const where = tagFilter
      ? ' WHERE r.scenario_name IN (SELECT scenario_name FROM scenario_tags WHERE tags LIKE $1)'
      : '';
    const res = await pool.query(
      `${base}${where} GROUP BY r.scenario_name ORDER BY r.scenario_name`,
      tagFilter ? [`%"${tagFilter}"%`] : [],
    );
    const rows = res.rows as Array<{
      name: string; last_run: string; last_success: number | null; last_duration_ms: number | null; total_runs: number;
    }>;

    const tagRes = await pool.query('SELECT scenario_name, tags FROM scenario_tags');
    const tagMap = new Map<string, string[] | undefined>(
      (tagRes.rows as { scenario_name: string; tags: string }[]).map(t => [t.scenario_name, parseTags(t.tags)]),
    );
    return rows.map(r => ({ ...r, total_runs: Number(r.total_runs), tags: tagMap.get(r.name) }));
  }

  async getScenarioHistory(name: string, limitDays: number, limit: number, offset: number): Promise<ScenarioMetrics[]> {
    const since = daysAgo(limitDays);
    const res = await this.handle.query(
      `SELECT
        r.id::int AS run_id, r.scenario_name, r.started_at, r.finished_at, r.duration_ms, r.success, r.flaky, r.created_at,
        s.id::int AS step_id, s.step_name, s.action, s.success AS step_success, s.status_code, s.response_time_ms, s.attempts, s.error, s.timestamp,
        s.request_url, s.request_method, s.request_headers, s.request_body, s.response_headers, s.response_body
      FROM (
        SELECT * FROM scenario_runs
        WHERE scenario_name = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      ) r
      LEFT JOIN step_metrics s ON s.run_id = r.id
      ORDER BY r.created_at DESC, s.id`,
      [name, since, limit, offset],
    );
    return collapseHistory(res.rows as HistoryRow[]);
  }

  async getScenarioPassedRunCount(name: string, limitDays: number): Promise<number> {
    const res = await this.handle.query(
      'SELECT COUNT(*) AS count FROM scenario_runs WHERE scenario_name = $1 AND created_at >= $2 AND success = 1',
      [name, daysAgo(limitDays)],
    );
    return Number(res.rows[0].count);
  }

  async getScenarioHistoryCount(name: string, limitDays: number): Promise<number> {
    const res = await this.handle.query(
      'SELECT COUNT(*) AS count FROM scenario_runs WHERE scenario_name = $1 AND created_at >= $2',
      [name, daysAgo(limitDays)],
    );
    return Number(res.rows[0].count);
  }

  async getScenarioStepNames(name: string): Promise<string[]> {
    const res = await this.handle.query(
      `SELECT DISTINCT step_name FROM step_metrics s
       JOIN scenario_runs r ON s.run_id = r.id
       WHERE r.scenario_name = $1
       ORDER BY step_name`,
      [name],
    );
    return res.rows.map(r => r.step_name as string);
  }

  async getPreviousRunSuccess(name: string): Promise<boolean | null> {
    const res = await this.handle.query(
      'SELECT success FROM scenario_runs WHERE scenario_name = $1 ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 1',
      [name],
    );
    return res.rows[0] ? res.rows[0].success === 1 : null;
  }

  async getLastRunSuccess(name: string): Promise<boolean | null> {
    const res = await this.handle.query(
      'SELECT success FROM scenario_runs WHERE scenario_name = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [name],
    );
    return res.rows[0] ? res.rows[0].success === 1 : null;
  }

  async purgeOldData(days: number): Promise<number> {
    const res = await this.handle.query('DELETE FROM scenario_runs WHERE created_at < $1', [daysAgo(days)]);
    return res.rowCount ?? 0;
  }

  async getScenarioTags(name: string): Promise<string[] | undefined> {
    const res = await this.handle.query('SELECT tags FROM scenario_tags WHERE scenario_name = $1', [name]);
    return res.rows[0] ? parseTags(res.rows[0].tags) : undefined;
  }

  async getDistinctTags(): Promise<string[]> {
    const res = await this.handle.query('SELECT DISTINCT tags FROM scenario_tags');
    const set = new Set<string>();
    for (const row of res.rows as { tags: string }[]) {
      for (const t of parseTags(row.tags) ?? []) set.add(t);
    }
    return [...set].sort();
  }

  async backup(directory: string): Promise<string> {
    fs.mkdirSync(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(directory, `scenarii-${timestamp}.sql`);
    await new Promise<void>((resolve, reject) => {
      execFile('pg_dump', [`--dbname=${this.connectionString}`, '-f', dest], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return dest;
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  async getUser(username: string): Promise<UserRow | undefined> {
    const res = await this.handle.query('SELECT username, role, created_at FROM users WHERE username = $1', [username]);
    return res.rows[0] as UserRow | undefined;
  }

  async listUsers(): Promise<UserRow[]> {
    const res = await this.handle.query('SELECT username, role, created_at FROM users ORDER BY username');
    return res.rows as UserRow[];
  }

  async countUsers(): Promise<number> {
    const res = await this.handle.query('SELECT COUNT(*) AS count FROM users');
    return Number(res.rows[0].count);
  }

  async insertUser(username: string, passwordHash: string, role: string, createdAt: string): Promise<boolean> {
    const res = await this.handle.query(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
      [username, passwordHash, role, createdAt],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setUserPassword(username: string, passwordHash: string): Promise<boolean> {
    const res = await this.handle.query('UPDATE users SET password_hash = $1 WHERE username = $2', [passwordHash, username]);
    return (res.rowCount ?? 0) > 0;
  }

  async getPasswordHash(username: string): Promise<string | undefined> {
    const res = await this.handle.query('SELECT password_hash FROM users WHERE username = $1', [username]);
    return (res.rows[0] as { password_hash: string } | undefined)?.password_hash;
  }

  async setUserRole(username: string, role: string): Promise<boolean> {
    const res = await this.handle.query('UPDATE users SET role = $1 WHERE username = $2', [role, username]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteUser(username: string): Promise<boolean> {
    const res = await this.handle.query('DELETE FROM users WHERE username = $1', [username]);
    return (res.rowCount ?? 0) > 0;
  }

  async getProfile(username: string): Promise<ProfileRow | undefined> {
    const res = await this.handle.query('SELECT email, avatar, lang, color_scheme, totp_enabled FROM users WHERE username = $1', [username]);
    return res.rows[0] as ProfileRow | undefined;
  }

  async updateProfile(username: string, email: string | null, lang: string, colorScheme: string): Promise<void> {
    await this.handle.query('UPDATE users SET email = $1, lang = $2, color_scheme = $3 WHERE username = $4', [email, lang, colorScheme, username]);
  }

  async getAvatar(username: string): Promise<{ mime: string; bytes: Buffer } | undefined> {
    const res = await this.handle.query('SELECT avatar, avatar_mime FROM users WHERE username = $1', [username]);
    const row = res.rows[0] as { avatar: Buffer | null; avatar_mime: string | null } | undefined;
    if (!row?.avatar?.length) return undefined;
    return { mime: row.avatar_mime || 'image/png', bytes: Buffer.from(row.avatar) };
  }

  async setAvatar(username: string, mime: string, bytes: Buffer): Promise<void> {
    await this.handle.query('UPDATE users SET avatar = $1, avatar_mime = $2 WHERE username = $3', [bytes, mime, username]);
  }

  async deleteAvatar(username: string): Promise<void> {
    await this.handle.query('UPDATE users SET avatar = NULL, avatar_mime = NULL WHERE username = $1', [username]);
  }

  async setTotpSecret(username: string, secret: string | null, recoveryJson: string | null): Promise<void> {
    await this.handle.query('UPDATE users SET totp_secret = $1, totp_recovery = $2 WHERE username = $3', [secret, recoveryJson, username]);
  }

  async enableTotp(username: string, secret: string, recoveryJson: string): Promise<boolean> {
    const res = await this.handle.query('UPDATE users SET totp_secret = $1, totp_recovery = $2, totp_enabled = 1 WHERE username = $3', [secret, recoveryJson, username]);
    return (res.rowCount ?? 0) > 0;
  }

  async disableTotp(username: string): Promise<boolean> {
    const res = await this.handle.query('UPDATE users SET totp_secret = NULL, totp_recovery = NULL, totp_enabled = 0 WHERE username = $1', [username]);
    return (res.rowCount ?? 0) > 0;
  }

  async getTotpSecret(username: string): Promise<string | undefined> {
    const res = await this.handle.query('SELECT totp_secret FROM users WHERE username = $1', [username]);
    return (res.rows[0] as { totp_secret: string | null } | undefined)?.totp_secret || undefined;
  }

  async getRecoveryCodes(username: string): Promise<string[]> {
    const res = await this.handle.query('SELECT totp_recovery FROM users WHERE username = $1', [username]);
    const row = res.rows[0] as { totp_recovery: string | null } | undefined;
    if (!row?.totp_recovery) return [];
    try { return JSON.parse(row.totp_recovery) as string[]; } catch { return []; }
  }

  async setRecoveryCodes(username: string, recoveryJson: string): Promise<void> {
    await this.handle.query('UPDATE users SET totp_recovery = $1 WHERE username = $2', [recoveryJson, username]);
  }

  async deletePasswordResets(username: string): Promise<void> {
    await this.handle.query('DELETE FROM password_resets WHERE username = $1', [username]);
  }

  async insertPasswordReset(username: string, tokenHash: string, expiresAt: string, createdAt: string): Promise<void> {
    await this.handle.query('INSERT INTO password_resets (token_hash, username, expires_at, created_at) VALUES ($1, $2, $3, $4)', [tokenHash, username, expiresAt, createdAt]);
  }

  async getPasswordReset(tokenHash: string): Promise<PasswordResetRow | undefined> {
    const res = await this.handle.query('SELECT username, expires_at FROM password_resets WHERE token_hash = $1', [tokenHash]);
    return res.rows[0] as PasswordResetRow | undefined;
  }

  async deletePasswordReset(tokenHash: string): Promise<void> {
    await this.handle.query('DELETE FROM password_resets WHERE token_hash = $1', [tokenHash]);
  }

  async prunePasswordResets(now: string): Promise<void> {
    await this.handle.query('DELETE FROM password_resets WHERE expires_at < $1', [now]);
  }

  async findUserByIdentifier(needle: string): Promise<string | undefined> {
    const wanted = needle.toLowerCase();
    const res = await this.handle.query('SELECT username FROM users WHERE lower(username) = $1 OR lower(email) = $1', [wanted]);
    return (res.rows[0] as { username: string } | undefined)?.username;
  }
}
