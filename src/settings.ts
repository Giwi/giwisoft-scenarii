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

let settings: Settings = {};

export function loadSettings(path?: string): Settings {
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
  return settings;
}
