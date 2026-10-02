import { Component, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, OnInit, ViewChild, inject, signal } from '@angular/core';
import { NgIf, NgFor } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../shared/auth';
import { I18nService, LANGS, LANG_NAMES, Lang } from '../../shared/i18n';
import type { MessageKey } from '../../shared/locales/en';
import { ColorScheme, SCHEMES, ThemeService } from '../../shared/theme';

// What /api/profile returns, plus the fields the page adds on top.
interface Profile {
  username: string;
  role: string;
  email: string | null;
  has_avatar: boolean;
  lang: Lang;
  color_scheme: ColorScheme;
  totp_enabled: boolean;
  totp_available: boolean;
  avatar_url: string | null;
  gravatar_url: string | null;
}

// A profile update, which also carries the server-rendered confirmation message.
type ProfileUpdate = Partial<Profile> & { message?: string };

// A pending two-factor setup, shown until the user confirms it with a code.
interface TotpSetup {
  secret: string;
  otpauth_uri: string;
  qr_code: string;
  account: string;
}

// Crop state for the avatar picker: the loaded image plus the square window over it.
interface CropState {
  image: HTMLImageElement;
  // Top-left corner of the crop window, in image pixels.
  x: number;
  y: number;
  // Visible width of the crop window, in image pixels. Smaller means more zoom.
  size: number;
}

const OUTPUT_SIZE = 256; // avatars are rendered at most 256px
const CROP_BOX = 280; // rendered crop window, in CSS pixels
const MIN_PASSWORD_LENGTH = 8;

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [NgIf, NgFor, FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './profile.html',
  styleUrl: './profile.css',
})
export class ProfileComponent implements OnInit {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);
  readonly theme = inject(ThemeService);

  readonly langs = LANGS;
  readonly langNames = LANG_NAMES;
  readonly schemes = SCHEMES;
  readonly minPasswordLength = MIN_PASSWORD_LENGTH;
  // Labels for the colour scheme picker, keyed so the template can look them up.
  readonly schemeLabels: Record<ColorScheme, MessageKey> = {
    light: 'profile.scheme_light',
    dark: 'profile.scheme_dark',
    auto: 'profile.scheme_auto',
  };

  // Translation helper, exposed so the template can call `t('key')`.
  readonly t = this.i18n.t;

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('cropCanvas') cropCanvas?: ElementRef<HTMLCanvasElement>;

  profile: Profile | null = null;
  loading = true;
  error = '';
  notice = '';

  // Account fields
  email = '';
  savingProfile = false;

  // Password change
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  savingPassword = false;

  // Two-factor
  setup: TotpSetup | null = null;
  totpCode = '';
  totpPassword = '';
  recoveryCodes: string[] | null = null;
  busy2fa = false;

  // Avatar crop dialog
  readonly cropping = signal(false);
  crop: CropState | null = null;
  uploading = false;
  // Pointer drag state, in image pixels.
  private dragging: { pointerX: number; pointerY: number; originX: number; originY: number } | null = null;

  async ngOnInit(): Promise<void> {
    await this.auth.load();
    await this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    try {
      const res = await fetch('/api/profile', { credentials: 'include' });
      if (!res.ok) throw new Error(await this.apiError(res));
      this.apply(await res.json() as Profile);
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.refresh();
    }
  }

  // The app is zoneless, so async work that lands on plain fields needs an explicit
  // change detection pass before the template can show it.
  private refresh(): void {
    this.cdr.detectChanges();
  }

  // ── Account ───────────────────────────────────────────────────────────────

  // Saves the account settings in one go: email, language and colour scheme. The
  // selectors preview their choices live, but the profile only changes once this is called.
  async saveProfile(): Promise<void> {
    this.savingProfile = true;
    this.error = '';
    try {
      const body = await this.post<ProfileUpdate>('/api/profile', {
        email: this.email,
        lang: this.i18n.lang(),
        color_scheme: this.theme.scheme(),
      }, 'PUT');
      this.apply(body);
      // The server renders its confirmation in the previous language, so say it here in
      // the language the page now uses.
      this.notice = this.t('profile.saved');
      // The email feeds the Gravatar URL in the navbar: refresh the session status.
      await this.auth.reload();
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.savingProfile = false;
      this.refresh();
    }
  }

  // Switches the interface language, instantly and locally. The profile saves it with
  // the Save button, like the colour scheme.
  setLang(lang: Lang): void {
    this.i18n.setLang(lang);
    this.refresh();
  }

  // Switches the colour scheme, instantly and locally.
  setScheme(scheme: ColorScheme): void {
    this.theme.setScheme(scheme);
    this.refresh();
  }

  // ── Password ──────────────────────────────────────────────────────────────

  async changePassword(): Promise<void> {
    if (this.newPassword.length < MIN_PASSWORD_LENGTH) {
      this.error = `${this.i18n.t('profile.password_help')} (${MIN_PASSWORD_LENGTH}+)`;
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error = this.i18n.t('profile.mismatch');
      return;
    }
    this.savingPassword = true;
    this.error = '';
    try {
      const body = await this.post<{ message?: string }>('/api/profile/password', {
        current_password: this.currentPassword,
        new_password: this.newPassword,
      });
      this.currentPassword = this.newPassword = this.confirmPassword = '';
      this.notice = body.message || '';
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.savingPassword = false;
      this.refresh();
    }
  }

  // ── Two-factor ────────────────────────────────────────────────────────────

  async startTwoFactor(): Promise<void> {
    this.busy2fa = true;
    this.error = '';
    try {
      this.setup = await this.post<TotpSetup>('/api/profile/totp/setup');
      this.totpCode = '';
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy2fa = false;
      this.refresh();
    }
  }

  // Abandons the setup. The pending secret was never enabled, and a new setup replaces it.
  cancelTwoFactorSetup(): void {
    this.setup = null;
    this.totpCode = '';
  }

  async confirmTwoFactor(): Promise<void> {
    this.busy2fa = true;
    this.error = '';
    try {
      const body = await this.post<{ recovery_codes: string[] }>('/api/profile/totp/enable', { code: this.totpCode });
      this.recoveryCodes = body.recovery_codes;
      this.setup = null;
      this.totpCode = '';
      if (this.profile) this.profile.totp_enabled = true;
      this.notice = this.i18n.t('profile.two_factor_active');
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy2fa = false;
      this.refresh();
    }
  }

  async disableTwoFactor(): Promise<void> {
    this.busy2fa = true;
    this.error = '';
    try {
      const body = await this.post<{ message?: string }>('/api/profile/totp/disable', {
        password: this.totpPassword, code: this.totpCode,
      });
      this.totpPassword = this.totpCode = '';
      if (this.profile) this.profile.totp_enabled = false;
      this.notice = body.message || '';
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy2fa = false;
      this.refresh();
    }
  }

  // ── Avatar ────────────────────────────────────────────────────────────────

  // Opens the file picker. Triggered from a button so the template needs no event juggling.
  pickFile(): void {
    this.fileInput?.nativeElement.click();
  }

  // Loads the chosen file into the crop dialog.
  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow picking the same file again after cancelling
    if (!file) return;
    this.error = '';
    try {
      const url = URL.createObjectURL(file);
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(this.i18n.t('profile.avatar_change')));
        image.src = url;
      });
      URL.revokeObjectURL(url);
      // Start fully zoomed out (the whole image fits) and centred.
      this.crop = { image, x: 0, y: 0, size: Math.min(image.naturalWidth, image.naturalHeight) };
      this.cropping.set(true);
      this.autoscale();
    } catch {
      this.error = this.i18n.t('profile.avatar_change');
    }
    this.refresh();
  }

  // The zoom level as a slider value: 1 is fully zoomed out, higher is closer.
  get zoomLevel(): number {
    if (!this.crop) return 1;
    return this.fullSize / this.crop.size;
  }

  setZoomLevel(value: number): void {
    this.zoom(value);
  }

  // Zooms to the smallest square that covers the image, i.e. fits the frame.
  autoscale(): void {
    if (!this.crop) return;
    this.crop.size = this.fullSize;
    this.centerCrop();
    this.drawCrop();
  }

  // Nudges the crop window by a fraction of its own size, keeping it inside the image.
  pan(fractionX: number, fractionY: number): void {
    if (!this.crop) return;
    const dx = fractionX * this.crop.size;
    const dy = fractionY * this.crop.size;
    this.crop.x = Math.min(Math.max(0, this.crop.x + dx), this.crop.image.naturalWidth - this.crop.size);
    this.crop.y = Math.min(Math.max(0, this.crop.y + dy), this.crop.image.naturalHeight - this.crop.size);
    this.drawCrop();
  }

  // Multiplies the zoom level, keeping the centre of the window where it is.
  zoom(factor: number): void {
    if (!this.crop) return;
    const previous = this.crop.size;
    const next = Math.min(Math.max(previous / factor, this.fullSize / 10), this.fullSize);
    const cx = this.crop.x + previous / 2;
    const cy = this.crop.y + previous / 2;
    this.crop.size = next;
    this.crop.x = Math.min(Math.max(0, cx - next / 2), this.crop.image.naturalWidth - next);
    this.crop.y = Math.min(Math.max(0, cy - next / 2), this.crop.image.naturalHeight - next);
    this.drawCrop();
  }

  // Drag to reposition: pointer coordinates map to image pixels through the crop scale.
  onPointerDown(event: PointerEvent): void {
    if (!this.crop) return;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.dragging = { pointerX: event.clientX, pointerY: event.clientY, originX: this.crop.x, originY: this.crop.y };
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.crop || !this.dragging) return;
    const perPixel = this.crop.size / CROP_BOX;
    this.crop.x = Math.min(Math.max(0, this.dragging.originX + (event.clientX - this.dragging.pointerX) * perPixel),
      this.crop.image.naturalWidth - this.crop.size);
    this.crop.y = Math.min(Math.max(0, this.dragging.originY + (event.clientY - this.dragging.pointerY) * perPixel),
      this.crop.image.naturalHeight - this.crop.size);
    this.drawCrop();
  }

  onPointerUp(): void {
    this.dragging = null;
  }

  cancelCrop(): void {
    this.cropping.set(false);
    this.crop = null;
    this.dragging = null;
  }

  // Renders the crop window to a square PNG and uploads it.
  async applyCrop(): Promise<void> {
    if (!this.crop) return;
    const { image, x, y, size } = this.crop;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x, y, size, size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    this.uploading = true;
    this.error = '';
    try {
      const body = await this.post<ProfileUpdate>('/api/profile/avatar', { image: canvas.toDataURL('image/png') });
      this.apply({ ...body, has_avatar: true });
      this.cancelCrop();
      await this.auth.reload();
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.uploading = false;
      this.refresh();
    }
  }

  // Drops the uploaded image so the avatar comes from Gravatar again.
  async removeAvatar(): Promise<void> {
    this.error = '';
    try {
      const body = await this.post<ProfileUpdate>('/api/profile/avatar', undefined, 'DELETE');
      this.apply({ ...body, has_avatar: false });
      await this.auth.reload();
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.refresh();
  }

  async copyRecoveryCodes(): Promise<void> {
    if (!this.recoveryCodes) return;
    await navigator.clipboard.writeText(this.recoveryCodes.join('\n'));
    this.notice = this.i18n.t('profile.recovery_codes_copied');
    this.refresh();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // The largest square the source image can offer, i.e. the fully zoomed-out window.
  private get fullSize(): number {
    const image = this.crop?.image;
    return image ? Math.min(image.naturalWidth, image.naturalHeight) : 1;
  }

  // Folds an API response into the page state. The confirmation comes from the server,
  // already translated, so the notice follows the interface language for free.
  private apply(update: ProfileUpdate): void {
    this.profile = { ...(this.profile ?? ({} as Profile)), ...update };
    this.email = this.profile.email || '';
    this.notice = update.message || '';
  }

  // POSTs a profile sub-resource and returns its JSON body. Throws with the server's
  // already translated message on failure.
  private async post<T = Record<string, unknown>>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await this.apiError(res));
    return res.json() as Promise<T>;
  }

  // Draws the scaled crop window; the canvas shows exactly what will be saved.
  private drawCrop(): void {
    const canvas = this.cropCanvas?.nativeElement;
    if (!canvas || !this.crop) return;
    const scale = CROP_BOX / this.crop.size;
    canvas.width = CROP_BOX;
    canvas.height = CROP_BOX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CROP_BOX, CROP_BOX);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.crop.image,
      this.crop.x * scale, this.crop.y * scale,
      this.crop.size * scale, this.crop.size * scale,
      0, 0, CROP_BOX, CROP_BOX,
    );
  }

  private centerCrop(): void {
    if (!this.crop) return;
    this.crop.x = (this.crop.image.naturalWidth - this.crop.size) / 2;
    this.crop.y = (this.crop.image.naturalHeight - this.crop.size) / 2;
  }

  // The API returns messages already translated server-side, so show them verbatim.
  private async apiError(res: Response): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || this.i18n.t('common.cancel');
  }
}