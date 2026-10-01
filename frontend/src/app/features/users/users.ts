import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, inject } from '@angular/core';
import { DatePipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../shared/auth';

interface UserRow {
  username: string;
  role: 'admin' | 'user';
  created_at: string;
}

// Admin-only page to list, add, promote, and delete dashboard users.
@Component({
  selector: 'app-users',
  standalone: true,
  imports: [NgFor, NgIf, FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class UsersComponent implements OnInit {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

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
        this.error = (await res.json().catch(() => ({ error: 'Failed to load users' })) as { error?: string }).error ?? 'Failed';
        return;
      }
      this.users = (await res.json() as { users: UserRow[] }).users;
    } catch {
      this.error = 'Failed to load users';
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
        this.error = data.error || 'Failed to create user';
        return;
      }
      if (data.generated_password) this.notice = `Password for ${username}: ${data.generated_password}`;
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
        this.error = data.error || 'Failed to update role';
        return;
      }
      u.role = role;
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }

  async resetPassword(u: UserRow): Promise<void> {
    const password = window.prompt(`New password for ${u.username} (empty to generate one):`);
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
        this.error = data.error || 'Failed to update password';
        return;
      }
      if (data.generated_password) this.notice = `Password for ${u.username}: ${data.generated_password}`;
      else this.notice = `Password updated for ${u.username}`;
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }

  async remove(u: UserRow): Promise<void> {
    if (!window.confirm(`Delete user ${u.username}?`)) return;
    this.busy = u.username;
    this.error = '';
    try {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(u.username)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        this.error = data.error || 'Failed to delete user';
        return;
      }
      this.users = this.users.filter(x => x.username !== u.username);
    } finally {
      this.busy = '';
      this.cdr.detectChanges();
    }
  }
}
