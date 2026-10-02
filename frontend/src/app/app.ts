import { Component, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
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

  async ngOnInit() {
    await this.auth.load();
    // The profile owns appearance and language: apply both as soon as the session is known.
    const status = this.auth.status();
    this.theme.setScheme(normalizeColorScheme(status.color_scheme));
    this.i18n.setLang(normalizeLang(status.lang));
  }

  async logout() {
    await this.auth.logout();
    window.location.href = '/login';
  }
}