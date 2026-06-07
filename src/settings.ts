import fs from 'fs';
import yaml from 'js-yaml';

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

export interface NotificationsConfig {
  telegram: TelegramConfig;
  email: EmailConfig;
}

export interface Settings {
  notifications?: NotificationsConfig;
}

let settings: Settings | undefined;

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

export function loadSettings(path?: string): Settings {
  if (settings !== undefined) {
    console.log('Settings already loaded, skipping');
    return settings;
  }

  const resolved = path || findSettingsFile();
  if (!resolved) {
    settings = {};
    return settings;
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    settings = yaml.load(raw) as Settings;
    console.log(`Settings loaded from ${resolved}`);
  } catch (err: unknown) {
    console.error(`Failed to load settings from ${resolved}:`, err instanceof Error ? err.message : err);
    settings = {};
  }

  applyEnvOverrides(settings);
  return settings;
}

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

export function getSettings(): Settings {
  return settings || {};
}
