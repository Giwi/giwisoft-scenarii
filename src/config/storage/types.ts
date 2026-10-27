import { ScenarioMetrics } from '../../types';

// Summary row returned by getScenarioList.
export interface ScenarioInfo {
  name: string;
  last_run: string | null;
  last_success: number | null;
  last_duration_ms: number | null;
  total_runs: number;
  tags?: string[];
}

// Raw user row from the `users` table (role is stored as a plain string).
export interface UserRow {
  username: string;
  role: string;
  created_at: string;
}

// Raw profile columns from the `users` table.
export interface ProfileRow {
  email: string | null;
  avatar: Buffer | null;
  lang: string;
  color_scheme: string;
  totp_enabled: number;
}

// Row returned by the password-reset lookup.
export interface PasswordResetRow {
  username: string;
  expires_at: string;
}

// Flat join row produced by getScenarioHistory, collapsed into ScenarioMetrics by
// the shared collapseHistory helper.
export interface HistoryRow {
  run_id: number;
  scenario_name: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  success: number;
  flaky: number;
  created_at: string;
  step_id: number | null;
  step_name: string | null;
  action: string | null;
  step_success: number | null;
  status_code: number | null;
  response_time_ms: number | null;
  attempts: number | null;
  error: string | null;
  timestamp: string | null;
  request_url?: string | null;
  request_method?: string | null;
  request_headers?: string | null;
  request_body?: string | null;
  response_headers?: string | null;
  response_body?: string | null;
}

// Pluggable storage backend. One implementation stores scenario runs and dashboard
// user accounts in SQLite, the other in PostgreSQL. All methods are async because
// PostgreSQL has no synchronous driver.
export interface StorageBackend {
  readonly type: 'sqlite' | 'postgres';

  // Lifecycle: connect and create/migrate the schema, then close cleanly.
  init(): Promise<void>;
  close(): Promise<void>;

  // ── Scenario runs / metrics ────────────────────────────────────────────────
  storeMetrics(metrics: ScenarioMetrics): Promise<void>;
  upsertScenarioTags(name: string, tags: string[]): Promise<void>;
  getScenarioList(tagFilter?: string): Promise<ScenarioInfo[]>;
  getScenarioHistory(name: string, limitDays: number, limit: number, offset: number): Promise<ScenarioMetrics[]>;
  getScenarioPassedRunCount(name: string, limitDays: number): Promise<number>;
  getScenarioHistoryCount(name: string, limitDays: number): Promise<number>;
  getScenarioStepNames(name: string): Promise<string[]>;
  getPreviousRunSuccess(name: string): Promise<boolean | null>;
  getLastRunSuccess(name: string): Promise<boolean | null>;
  purgeOldData(days: number): Promise<number>;
  getScenarioTags(name: string): Promise<string[] | undefined>;
  getDistinctTags(): Promise<string[]>;
  backup(directory: string): Promise<string>;

  // ── Users ─────────────────────────────────────────────────────────────────
  getUser(username: string): Promise<UserRow | undefined>;
  listUsers(): Promise<UserRow[]>;
  countUsers(): Promise<number>;
  insertUser(username: string, passwordHash: string, role: string, createdAt: string): Promise<boolean>;
  setUserPassword(username: string, passwordHash: string): Promise<boolean>;
  getPasswordHash(username: string): Promise<string | undefined>;
  setUserRole(username: string, role: string): Promise<boolean>;
  deleteUser(username: string): Promise<boolean>;

  getProfile(username: string): Promise<ProfileRow | undefined>;
  updateProfile(username: string, email: string | null, lang: string, colorScheme: string): Promise<void>;
  getAvatar(username: string): Promise<{ mime: string; bytes: Buffer } | undefined>;
  setAvatar(username: string, mime: string, bytes: Buffer): Promise<void>;
  deleteAvatar(username: string): Promise<void>;

  setTotpSecret(username: string, secret: string | null, recoveryJson: string | null): Promise<void>;
  enableTotp(username: string, secret: string, recoveryJson: string): Promise<boolean>;
  disableTotp(username: string): Promise<boolean>;
  getTotpSecret(username: string): Promise<string | undefined>;
  getRecoveryCodes(username: string): Promise<string[]>;
  setRecoveryCodes(username: string, recoveryJson: string): Promise<void>;

  deletePasswordResets(username: string): Promise<void>;
  insertPasswordReset(username: string, tokenHash: string, expiresAt: string, createdAt: string): Promise<void>;
  getPasswordReset(tokenHash: string): Promise<PasswordResetRow | undefined>;
  deletePasswordReset(tokenHash: string): Promise<void>;
  prunePasswordResets(now: string): Promise<void>;
  findUserByIdentifier(needle: string): Promise<string | undefined>;
}
