import fs from 'fs';
import yaml from 'js-yaml';
import logger from './logger';

// Notification channel configuration types
export interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
}

export interface MailgunConfig {
  api_key: string;
  domain: string;
  from: string;
}

export interface EmailConfig {
  enabled: boolean;
  mailgun: MailgunConfig;
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
}

export interface NotificationsConfig {
  telegram: TelegramConfig;
  email: EmailConfig;
  slack?: SlackConfig;
  discord?: DiscordConfig;
  webhook?: WebhookConfig;
}

// API-level authentication settings (API key or OIDC)
export interface ApiConfig {
  auth?: {
    enabled?: boolean;
    api_key: string;
  };
}

export interface BackupConfig {
  enabled: boolean;
  cron?: string;
  directory?: string;
}

export interface OidcConfig {
  issuer_url: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes?: string;
}

export interface AuthConfig {
  enabled: boolean;
  oidc?: OidcConfig;
}

export interface StorageConfig {
  retentionDays?: number;
  backup?: BackupConfig;
}

// Per-scenario overrides for browser and notification settings
export interface ScenarioOverrides {
  ignoreHTTPSErrors?: boolean;
  timeout?: number;
  notifications?: { enabled?: boolean };
}

// Top-level settings object loaded from settings.yaml
export interface Settings {
  api?: ApiConfig;
  auth?: AuthConfig;
  storage?: StorageConfig;
  notifications?: NotificationsConfig;
  scenarios?: Record<string, ScenarioOverrides>;
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
