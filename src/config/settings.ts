import fs from 'fs';
import yaml from 'js-yaml';
import logger from '../utils/logger';

// Notification channel configuration types
export interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
}

export interface MailgunConfig {
  api_key: string;
  domain: string;
  // Kept for backward compatibility; prefer the shared email.from.
  from?: string;
}

// SMTP transport. `tls: true` opens an implicit TLS (SMTPS) connection, otherwise the
// client connects plaintext and upgrades with STARTTLS when the server advertises it.
export interface SmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  // Verify the server certificate. Defaults to true. Set false only for self-signed relays.
  rejectUnauthorized?: boolean;
  // Extra CA certificate(s) in PEM form, trusted in addition to the system store.
  ca?: string;
}

export interface EmailConfig {
  enabled: boolean;
  // Sender address shared by both transports. Falls back to mailgun.from when omitted.
  from?: string;
  mailgun?: MailgunConfig;
  smtp?: SmtpConfig;
  to: string[];
}

export interface SlackConfig {
  enabled: boolean;
  webhook_url: string;
}

export interface DiscordConfig {
  enabled: boolean;
  webhook_url: string;
}

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  // HTTP method for the delivery request. Defaults to POST.
  method?: 'POST' | 'PUT' | 'PATCH';
  // Extra headers merged into the request.
  headers?: Record<string, string>;
  // Optional body template. Supports {{scenario}}, {{event}}, {{success}},
  // {{duration_ms}}, {{started_at}}, {{finished_at}}, and {{steps}} (JSON).
  template?: string;
  // Sign the exact request body with HMAC-SHA256.
  signing_secret?: string;
  signing_header?: string;
  // Defaults to "sha256=".
  signature_prefix?: string;
}

export interface TeamsConfig {
  enabled: boolean;
  webhook_url: string;
}

export interface NtfyConfig {
  enabled: boolean;
  // Server base URL, e.g. https://ntfy.sh
  url: string;
  topic: string;
  // Optional bearer token for protected topics.
  token?: string;
  // ntfy priority 1-5. Defaults to 4.
  priority?: number;
}

export interface PagerDutyConfig {
  enabled: boolean;
  routing_key: string;
  // Incident severity. Defaults to "critical".
  severity?: 'critical' | 'error' | 'warning' | 'info';
}

// Global suppression. `muted` silences everything until turned off; `maintenance`
// suppresses only inside the ISO timestamp window.
export interface MaintenanceWindowConfig {
  enabled?: boolean;
  start?: string;
  end?: string;
}

export interface NotificationsConfig {
  telegram: TelegramConfig;
  email: EmailConfig;
  slack?: SlackConfig;
  discord?: DiscordConfig;
  webhook?: WebhookConfig;
  teams?: TeamsConfig;
  ntfy?: NtfyConfig;
  pagerduty?: PagerDutyConfig;
  muted?: boolean;
  maintenance?: MaintenanceWindowConfig;
}

// API-level authentication settings (API key or OIDC)
export type ApiScope = 'trigger' | 'read' | 'admin';

export interface ApiTokenConfig {
  // Human-readable label, used in logs and docs.
  name?: string;
  token: string;
  // Granted scopes. `admin` implies trigger and read. Defaults to ['admin'].
  scopes?: ApiScope[];
}

export interface ApiAuthConfig {
  enabled?: boolean;
  // Legacy single key. Treated as an admin-scoped token when present.
  api_key: string;
  // Scoped bearer tokens for CI and integrations.
  tokens?: ApiTokenConfig[];
}

export interface ApiConfig {
  auth?: ApiAuthConfig;
}

export interface BackupConfig {
  enabled: boolean;
  cron?: string;
  directory?: string;
  retention?: number;
}

export interface OidcConfig {
  issuer_url: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes?: string;
  // Claim holding the group memberships, used to derive the user role.
  groups_claim?: string;
  // Claim holding the username. Falls back to email then sub when unset.
  username_claim?: string;
  // Group membership granting the admin role.
  admin_group?: string;
}

export type AuthProvider = 'local' | 'oidc';

export interface AuthConfig {
  enabled?: boolean;
  provider?: AuthProvider;
  default_user?: string;
  // Role granted to the auto-created default user (admin or user).
  default_user_role?: 'admin' | 'user';
  oidc?: OidcConfig;
}

export interface StorageConfig {
  retentionDays?: number;
  backup?: BackupConfig;
  // Storage backend: 'sqlite' (default) or 'postgres'.
  type?: 'sqlite' | 'postgres';
  // PostgreSQL connection string (used when type is 'postgres').
  url?: string;
  // SQLite database file path (used when type is 'sqlite').
  path?: string;
}

// Per-scenario overrides for browser and notification settings
export interface ScenarioOverrides {
  ignoreHTTPSErrors?: boolean;
  timeout?: number;
  notifications?: { enabled?: boolean };
}

// Inbound CI webhooks (GitHub/GitLab push and pull/merge request events)
export type WebhookProvider = 'github' | 'gitlab';

export interface WebhookRuleConfig {
  provider?: WebhookProvider;
  // Repository full name: "org/repo" (GitHub) or "group/project" (GitLab).
  repository?: string;
  // Events to accept: "push", "pull_request", "merge_request". Defaults to all.
  events?: string[];
  // Branch patterns matched against the pushed branch or the PR/MR target branch.
  // Supports "*" wildcards, e.g. "main", "release/*".
  branches?: string[];
  // Scenario to run when the rule matches.
  scenario: string;
  // Extra scenario variables. Supports {{repository}}, {{branch}}, {{target_branch}},
  // {{sha}}, {{pr}}, {{event}}, {{action}}.
  variables?: Record<string, string>;
}

export interface InboundWebhookConfig {
  enabled?: boolean;
  // Shared secret. GitHub uses HMAC-SHA256 (X-Hub-Signature-256); GitLab uses the
  // secret token (X-Gitlab-Token).
  secret?: string;
  // Scenario used when no rule matches, if set.
  scenario?: string;
  rules?: WebhookRuleConfig[];
}


// Top-level settings object loaded from settings.yaml
export interface Settings {
  api?: ApiConfig;
  auth?: AuthConfig;
  storage?: StorageConfig;
  notifications?: NotificationsConfig;
  scenarios?: Record<string, ScenarioOverrides>;
  webhooks?: InboundWebhookConfig;
}

let settings: Settings | undefined;
let settingsPath: string | undefined;

// Applies environment-variable overrides for notification credentials when the YAML values are empty.
function applyEnvOverrides(s: Settings): void {
  if (!s.notifications) return;
  if (s.notifications.telegram && !s.notifications.telegram.bot_token && process.env.TELEGRAM_BOT_TOKEN) {
    s.notifications.telegram.bot_token = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (s.notifications.telegram && !s.notifications.telegram.chat_id && process.env.TELEGRAM_CHAT_ID) {
    s.notifications.telegram.chat_id = process.env.TELEGRAM_CHAT_ID;
  }
  if (s.notifications.email?.mailgun && !s.notifications.email.mailgun.api_key && process.env.MAILGUN_API_KEY) {
    s.notifications.email.mailgun.api_key = process.env.MAILGUN_API_KEY;
  }
  if (s.notifications.email?.mailgun && !s.notifications.email.mailgun.domain && process.env.MAILGUN_DOMAIN) {
    s.notifications.email.mailgun.domain = process.env.MAILGUN_DOMAIN;
  }
  if (s.notifications.email?.smtp && !s.notifications.email.smtp.host && process.env.SMTP_HOST) {
    s.notifications.email.smtp.host = process.env.SMTP_HOST;
  }
  if (s.notifications.email?.smtp && !s.notifications.email.smtp.port && process.env.SMTP_PORT) {
    s.notifications.email.smtp.port = Number(process.env.SMTP_PORT);
  }
  if (s.notifications.email?.smtp && !s.notifications.email.smtp.username && process.env.SMTP_USERNAME) {
    s.notifications.email.smtp.username = process.env.SMTP_USERNAME;
  }
  if (s.notifications.email?.smtp && !s.notifications.email.smtp.password && process.env.SMTP_PASSWORD) {
    s.notifications.email.smtp.password = process.env.SMTP_PASSWORD;
  }
}

// Loads settings from a YAML file. Subsequent calls are no-ops unless the file changes.
export function loadSettings(path?: string): Settings {
  if (settings !== undefined) {
    logger.info('Settings already loaded, skipping');
    return settings;
  }

  const resolved = path || findSettingsFile();
  if (!resolved) {
    settings = {};
    return settings;
  }

  settingsPath = resolved;

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    settings = yaml.load(raw) as Settings;
    logger.info(`Settings loaded from ${resolved}`);
  } catch (err: unknown) {
    logger.error({ resolved, err: err instanceof Error ? err.message : String(err) }, 'Failed to load settings');
    settings = {};
  }

  applyEnvOverrides(settings);
  return settings;
}

// Re-reads settings from disk and merges env overrides. Used by watchSettings.
export function reloadSettings(): Settings {
  if (!settingsPath) return settings || {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const newSettings = yaml.load(raw) as Settings;
    applyEnvOverrides(newSettings);
    settings = newSettings;
    logger.info(`Settings reloaded from ${settingsPath}`);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to reload settings');
  }
  return settings!;
}

// Watches the settings file for changes and reloads it automatically every 3 seconds.
export function watchSettings(): void {
  if (!settingsPath) return;
  fs.watchFile(settingsPath, { interval: 3000 }, () => {
    logger.info('Settings file changed, reloading...');
    reloadSettings();
  });
}

// Searches common paths for a settings file.
function findSettingsFile(): string | null {
  const candidates = [
    'settings.yaml',
    'settings.yml',
    '/app/settings.yaml',
    '/app/settings.yml',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Returns the current settings object (may be empty if none were loaded).
export function getSettings(): Settings {
  return settings || {};
}

// Returns per-scenario override settings for the named scenario.
export function getScenarioSettings(name: string): ScenarioOverrides {
  return getSettings().scenarios?.[name] ?? {};
}
