import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { NgFor, NgIf, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { I18nService } from '../../shared/i18n';

interface ArtifactFile {
  name: string;
  path: string;
  type: string;
}

@Component({
  selector: 'app-artifacts',
  standalone: true,
  imports: [NgFor, NgIf, DatePipe],
  templateUrl: './artifacts.html',
  styleUrl: './artifacts.css',
})
export class ArtifactsComponent implements OnInit {
  files: ArtifactFile[] = [];
  loading = true;
  selected: ArtifactFile | null = null;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef, public i18n: I18nService) {}

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const res: any = await this.http.get('/api/artifacts/screenshots', { withCredentials: true }).toPromise();
      this.files = res.files || [];
    } catch {
      this.files = [];
    }
    this.loading = false;
    this.cdr.detectChanges();
  }

  getFileUrl(f: ArtifactFile): string {
    return '/api/artifacts/screenshots/file?file=' + encodeURIComponent(f.path);
  }

  view(f: ArtifactFile): void {
    this.selected = f;
    this.cdr.detectChanges();
  }

  close(): void {
    this.selected = null;
    this.cdr.detectChanges();
  }

  async approve(f: ArtifactFile): Promise<void> {
    try {
      await this.http.post('/api/artifacts/screenshots/approve', { file: f.path }, { withCredentials: true }).toPromise();
      await this.load();
    } catch {}
  }

  async reject(f: ArtifactFile): Promise<void> {
    try {
      await this.http.post('/api/artifacts/screenshots/reject', { file: f.path }, { withCredentials: true }).toPromise();
      await this.load();
    } catch {}
  }
}
