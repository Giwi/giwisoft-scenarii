import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from './i18n';

// Date shapes the app shows. Angular's own locale data only ships with English, so the
// months would stay "Feb" for every language; Intl formats them per language instead.
type DateStyle = 'short' | 'withSeconds' | 'numeric';

const OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  withSeconds: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' },
  numeric: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
};

// Formatters are expensive to build and perfectly reusable, so they are cached per
// language and shape.
const cache = new Map<string, Intl.DateTimeFormat>();

// Renders a timestamp in the interface language, e.g. "Feb 3, 14:22" becomes
// "févr. 3, 14:22" in French. Impure because the language can change under a live page.
@Pipe({ name: 'langDate', standalone: true, pure: false })
export class LangDatePipe implements PipeTransform {
  private i18n = inject(I18nService);

  transform(value: string | number | Date | null | undefined, style: DateStyle = 'short'): string {
    if (value === null || value === undefined || value === '') return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const lang = this.i18n.lang();
    const key = `${lang}:${style}`;
    let formatter = cache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(lang, OPTIONS[style]);
      cache.set(key, formatter);
    }
    return formatter.format(date);
  }
}
