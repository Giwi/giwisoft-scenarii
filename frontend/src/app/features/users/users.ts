import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../shared/auth';
import { I18nService } from '../../shared/i18n';
import { LangDatePipe } from '../../shared/lang-date.pipe';

interface UserRow {
  username: string;
  role: 'admin' | 'user';
  created_at: string;
}

// Admin-only page to list, add, promote, and delete dashboard users.
@Component({
  selector: 'app-users',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, LangDatePipe],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class UsersComponent implements OnInit {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);

  // Translation helper, exposed so the template can call `t('key')`.
  readonly t = this.i18n.t;

  users: UserRow[] = [];
  loading = true;
  error = '';
  notice = '';

  // Add form
  newUsername = '';
  newPassword = '';
  newRole: 'admin' | 'user' = 'user';

  // Per-row working state
  busy = '';

  ngOnInit(): void {
    this.load();
  }

  get me(): string | null {
    return this.auth.status().username;
  }

  async load(): Promise<void> {
    this.error = '';
    try {
      const res = await fetch('/api/auth/users', { credentials: 'include' });
      if (!res.ok) {
        this.error = (await res.json().catch(() => ({ error: this.t('common.fail') })) as { error?: string }).error ?? this.t('common.fail');
        return;
      }
      this.users = (await res.json() as { users: UserRow[] }).users;
    } catch {
      this.error = this.t('common.fail');
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  async add(): Promise<void> {
    const username = this.newUsername.trim();
    if (!username) return;
    this.busy = 'add';
    this.error = '';
    this.notice = '';
    try {
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username,
          password: this.newPassword || undefined,
          role: this.newRole,
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; generated_password?: string };
      if (!res.ok) {
        this.error = data.error || this.t('common.fail');
        return;
      }
      if (data.generated_password) {
        this.notice = this.t('users.generated_password', { username, password: data.generated_password });
      }
      this.newUsername = '';
      this.newPassword = '';
      this.newRole = 'user';
      await this.load();
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }

  async setRole(u: UserRow, role: 'admin' | 'user'): Promise<void> {
    if (role === u.role) return;
    this.busy = u.username;
    this.error = '';
    try {
      const res = await fetch('/api/auth/users/role', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: u.username, role }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        this.error = data.error || this.t('common.fail');
        return;
      }
      u.role = role;
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }

  async resetPassword(u: UserRow): Promise<void> {
    const password = window.prompt(`${this.t('recover.new_password')} ${u.username} (${this.t('users.password_hint')})`);
    if (password === null) return;
    this.busy = u.username;
    this.error = '';
    this.notice = '';
    try {
      const res = await fetch('/api/auth/users/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: u.username, password: password || undefined }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; generated_password?: string };
      if (!res.ok) {
        this.error = data.error || this.t('common.fail');
        return;
      }
      if (data.generated_password) {
        this.notice = this.t('users.generated_password', { username: u.username, password: data.generated_password });
      } else {
        this.notice = this.t('users.password_updated', { username: u.username });
      }
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }

  async remove(u: UserRow): Promise<void> {
    if (!window.confirm(this.t('users.delete_confirm', { username: u.username }))) return;
    this.busy = u.username;
    this.error = '';
    try {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(u.username)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        this.error = data.error || this.t('common.fail');
        return;
      }
      this.users = this.users.filter(x => x.username !== u.username);
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }
}
