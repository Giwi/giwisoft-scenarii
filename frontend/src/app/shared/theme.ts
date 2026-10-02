import { Injectable, computed, signal } from '@angular/core';

// Colour scheme chosen in the user profile, mirrored into Bootstrap's data-bs-theme.
export type ColorScheme = 'light' | 'dark' | 'auto';

// Where the choice is cached before the profile page knows the user.
const STORAGE_KEY = 'scenarii-scheme';

export const SCHEMES: ColorScheme[] = ['light', 'dark', 'auto'];

// Coerces anything into a supported colour scheme.
export function normalizeColorScheme(value: unknown): ColorScheme {
  return value === 'dark' || value === 'auto' ? value : 'light';
}

// Applies and remembers the colour scheme. `auto` follows the operating system and keeps
// following it while the app is open.
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly query = window.matchMedia('(prefers-color-scheme: dark)');

  private readonly _scheme = signal<ColorScheme>(this.storedScheme());

  // 'auto' resolved to what the operating system currently asks for.
  private readonly _systemDark = signal(this.query.matches);

  readonly scheme = this._scheme.asReadonly();

  readonly resolved = computed<'light' | 'dark'>(() => {
    const scheme = this._scheme();
    if (scheme === 'auto') return this._systemDark() ? 'dark' : 'light';
    return scheme;
  });

  constructor() {
    this.query.addEventListener('change', event => {
      this._systemDark.set(event.matches);
      this.apply();
    });
    this.apply();
  }

  private storedScheme(): ColorScheme {
    return normalizeColorScheme(localStorage.getItem(STORAGE_KEY));
  }

  setScheme(scheme: ColorScheme): void {
    const next = normalizeColorScheme(scheme);
    this._scheme.set(next);
    localStorage.setItem(STORAGE_KEY, next);
    this.apply();
  }

  // Writes the resolved scheme onto <html>, which the stylesheet keys off.
  private apply(): void {
    document.documentElement.setAttribute('data-bs-theme', this.resolved());
  }
}