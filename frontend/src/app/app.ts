import { Component, OnInit, ChangeDetectionStrategy, effect, inject, untracked } from '@angular/core';
import { Router, RouterOutlet, RouterLink } from '@angular/router';
import { NgIf } from '@angular/common';
import { AuthService } from './shared/auth';
import { I18nService, normalizeLang } from './shared/i18n';
import { normalizeColorScheme, ThemeService } from './shared/theme';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, NgIf],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private auth = inject(AuthService);
  readonly i18n = inject(I18nService);
  readonly theme = inject(ThemeService);

  status = this.auth.status;
  isAdmin = this.auth.isAdmin;
  ready = this.auth.ready;
  router = inject(Router);

  // Bound so the template can call `t('key')`.
  readonly t = this.i18n.t;

  // The profile owns appearance and language. They are re-applied every time the session
  // becomes known, not just at boot: the shell starts anonymous (light by default), so a
  // login that happens later must land on the choice stored in the profile.
  private readonly applyProfilePreferences = effect(() => {
    const status = this.auth.status();
    if (!status.authenticated) return;
    // setScheme reads the scheme signal internally; without untracked, that silent read
    // would make this effect depend on the scheme itself and fight the profile page's
    // live preview every time the user picks a colour.
    untracked(() => {
      this.theme.setScheme(normalizeColorScheme(status.color_scheme));
      this.i18n.setLang(normalizeLang(status.lang));
    });
  });

  async ngOnInit() {
    await this.auth.load();
  }

  async logout() {
    await this.auth.logout();
    window.location.href = '/login';
  }
}