import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, inject } from '@angular/core';
import { NgIf, NgFor } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { AuthService } from '../../shared/auth';
import { I18nService } from '../../shared/i18n';
import type { MessageKey } from '../../shared/locales/en';

interface Feature {
  icon: string;
  title: MessageKey;
  text: MessageKey;
}

// The form the visitor is on: credentials, the second factor, recovery, or a reset.
type Step = 'login' | 'two-factor' | 'forgot' | 'reset';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [NgIf, NgFor, FormsModule, RouterModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './landing.html',
  styleUrl: './landing.css',
})
export class LandingComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);

  readonly authenticated = this.auth.status;
  readonly t = this.i18n.t;

  step: Step = 'login';
  username = '';
  password = '';
  code = '';
  identifier = '';
  newPassword = '';
  confirmPassword = '';
  error = '';
  notice = '';
  busy = false;
  // Challenge id handed out by the server after the password step, valid for five minutes.
  private challenge = '';

  readonly features: Feature[] = [
    { icon: 'bi-file-text', title: 'feature.yaml_title', text: 'feature.yaml_text' },
    { icon: 'bi-clock-history', title: 'feature.cron_title', text: 'feature.cron_text' },
    { icon: 'bi-window-stack', title: 'feature.browser_title', text: 'feature.browser_text' },
    { icon: 'bi-database', title: 'feature.sqlite_title', text: 'feature.sqlite_text' },
    { icon: 'bi-bell', title: 'feature.alerts_title', text: 'feature.alerts_text' },
    { icon: 'bi-speedometer2', title: 'feature.dashboard_title', text: 'feature.dashboard_text' },
  ];

  async ngOnInit(): Promise<void> {
    await this.auth.load();
    // A recovery link lands on /login?reset=<token>: show the reset form straight away.
    const token = this.route.snapshot.queryParamMap.get('reset');
    if (token) {
      this.step = 'reset';
      this.resetToken = token;
      return;
    }
    if (this.auth.status().authenticated) {
      await this.router.navigate(['/scenarios']);
    }
  }

  private resetToken = '';

  async submit(): Promise<void> {
    this.busy = true;
    this.error = '';
    const result = await this.auth.login(this.username, this.password);
    this.busy = false;
    if (result.error) {
      this.error = result.error;
      this.cdr.detectChanges();
      return;
    }
    if (result.challenge) {
      // Password accepted: the session waits for the second factor.
      this.challenge = result.challenge;
      this.step = 'two-factor';
      this.cdr.detectChanges();
      return;
    }
    await this.router.navigate([this.next]);
  }

  async submitTwoFactor(): Promise<void> {
    this.busy = true;
    this.error = '';
    const result = await this.auth.loginWithTotp(this.challenge, this.code);
    this.busy = false;
    if (result.error) {
      this.error = result.error;
      this.cdr.detectChanges();
      return;
    }
    await this.router.navigate([this.next]);
  }

  async submitForgot(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.notice = '';
    const result = await this.auth.requestPasswordReset(this.identifier);
    this.busy = false;
    if (result.error) {
      this.error = result.error;
      this.cdr.detectChanges();
      return;
    }
    // The server answers the same way for an unknown account, so this is the whole answer.
    this.notice = result.message || this.t('recover.sent');
    this.cdr.detectChanges();
  }

  async submitReset(): Promise<void> {
    if (this.newPassword !== this.confirmPassword) {
      this.error = this.t('recover.mismatch');
      return;
    }
    this.busy = true;
    this.error = '';
    const result = await this.auth.resetPassword(this.resetToken, this.newPassword);
    this.busy = false;
    if (result.error) {
      this.error = result.error;
      this.cdr.detectChanges();
      return;
    }
    this.notice = result.message || '';
    this.newPassword = this.confirmPassword = '';
    this.step = 'login';
    this.cdr.detectChanges();
  }

  // Back to the credential form: forget the half-finished challenge and token.
  backToLogin(): void {
    this.step = 'login';
    this.code = '';
    this.error = '';
    this.notice = '';
    this.challenge = '';
  }

  oidcLogin(): void {
    this.auth.loginWithOidc();
  }

  // Where to go once signed in: remember an explicit destination, else the dashboard.
  private get next(): string {
    const target = this.route.snapshot.queryParamMap.get('next');
    return target && target.startsWith('/') ? target : '/scenarios';
  }
}