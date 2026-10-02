import { Injectable, signal } from '@angular/core';
import type { Messages, MessageKey } from './locales/en';
import { en } from './locales/en';
import { fr } from './locales/fr';
import { es } from './locales/es';
import { de } from './locales/de';

export type Lang = 'en' | 'fr' | 'es' | 'de';

// Supported languages, in menu order. `en` is the source language.
export const LANGS: Lang[] = ['en', 'fr', 'es', 'de'];

// Each language names itself, not the others.
export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
};

// Typing the catalogues as `Messages` makes a missing or extra key a build error.
const CATALOGUES: Record<Lang, Messages> = { en, fr, es, de };

// Where the choice is cached before the profile page knows the user.
const STORAGE_KEY = 'scenarii-lang';

// Coerces anything into a supported language.
export function normalizeLang(value: unknown): Lang {
  return typeof value === 'string' && (LANGS as string[]).includes(value) ? value as Lang : 'en';
}

// Picks the best supported language from an Accept-Language header value.
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  if (!header) return 'en';
  const wanted = header.split(',').map(part => {
    const [tag, q] = part.trim().split(';q=');
    return { tag: (tag || '').trim().toLowerCase(), q: q ? parseFloat(q) || 0 : 1 };
  }).filter(item => item.tag).sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    if ((LANGS as string[]).includes(tag)) return tag as Lang;
    const base = tag.split('-')[0];
    if ((LANGS as string[]).includes(base)) return base as Lang;
  }
  return 'en';
}

// Looks a message up in the active catalogue, falling back to English and then to the
// key itself, so a gap is visible instead of rendering an empty string.
export function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const message = CATALOGUES[lang]?.[key] ?? en[key] ?? key;
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]));
}

// Language of the interface. Templates call `i18n.t('key')`; Angular re-renders them
// when the signal changes, so switching language is instant.
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly _lang = signal<Lang>(this.storedLang());

  readonly lang = this._lang.asReadonly();

  // Bound so templates can call `t('key')` directly.
  readonly t = (key: MessageKey, params?: Record<string, string | number>): string =>
    translate(this._lang(), key, params);

  // Screen readers and the browser's own hyphenation need the document language, including
  // on the first paint, before anyone has switched it.
  constructor() {
    document.documentElement.setAttribute('lang', this._lang());
  }

  // The language to start with: the cached choice, else the browser's preference, else English.
  private storedLang(): Lang {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeLang(saved);
    return langFromAcceptLanguage(navigator.language);
  }

  // Switches language for the whole app and remembers the choice.
  setLang(lang: Lang): void {
    const next = normalizeLang(lang);
    this._lang.set(next);
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.setAttribute('lang', next);
  }
}