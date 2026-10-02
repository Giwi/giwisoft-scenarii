import { Component, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, OnInit, ViewChild, effect, inject, signal } from '@angular/core';
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

// ── Manual square crop, ported from the Cookie-challenge ImageCropper ────────
// The framing is described by two numbers only: a zoom (>= 1, 1 means the image just
// covers the frame) and a pan normalized to [-1, 1] (1 means shifted as far as possible
// while still covering). That frame is independent of the canvas size, so the on-screen
// preview and the exported avatar share exactly the same rectangle (see cropRect).

interface CropView {
  zoom: number;
  pan: { x: number; y: number };
}

// The decoded picture: an ImageBitmap on modern browsers, an <img> as a fallback.
type CropImage = HTMLImageElement | ImageBitmap;

interface CropState {
  image: CropImage;
  view: CropView;
}

const sizeOf = (image: CropImage): { width: number; height: number } =>
  image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };

// A live pointer gesture: one pointer drags, two pointers pinch (zoom + recentre).
interface Gesture {
  count: number;
  x: number;
  y: number;
  dist?: number;
}

const OUTPUT_SIZE = 256; // avatar export, in pixels
const FRAME = 288; // preview frame, in CSS pixels (mirrors ImageCropper)
const MAX_ZOOM = 4; // mirrors lib/image.js
const ZOOM_STEP = 1.25;
const CENTER = { x: 0.5, y: 0.5 }; // frame point kept fixed while zooming with the buttons

const clampZoom = (zoom: number): number => Math.max(1, Math.min(MAX_ZOOM, zoom));

const clampPan = (x: number, y: number): { x: number; y: number } => ({
  x: Math.max(-1, Math.min(1, x)),
  y: Math.max(-1, Math.min(1, y)),
});

// The image's rectangle inside a `size`-px square, in canvas coordinates: centred, then
// shifted by the normalized pan. Both the preview and the export call this.
function cropRect(image: CropImage, size: number, zoom: number, pan: { x: number; y: number }) {
  const { width, height } = sizeOf(image);
  const base = Math.max(size / width, size / height);
  const w = width * base * zoom;
  const h = height * base * zoom;
  return {
    x: (size - w) / 2 + (pan.x * (w - size)) / 2,
    y: (size - h) / 2 + (pan.y * (h - size)) / 2,
    w,
    h,
  };
}

// Zooms while keeping the image pixel under `point` (frame fractions 0..1) fixed. Used by
// the wheel, the pinch and the slider so the zoom always happens where the eye is.
function zoomAtPointer(image: CropImage, zoom: number, pan: { x: number; y: number }, nextZoom: number, point: { x: number; y: number }): CropView {
  const { width, height } = sizeOf(image);
  const ratio = width / height;
  const span = (z: number): [number, number] => (ratio >= 1 ? [ratio * z, z] : [z, z / ratio]);
  const [rx, ry] = span(zoom);
  const [nx, ny] = span(nextZoom);
  const cx = 0.5 + (pan.x * (rx - 1)) / 2;
  const cy = 0.5 + (pan.y * (ry - 1)) / 2;
  const ux = (point.x - (cx - rx / 2)) / rx;
  const uy = (point.y - (cy - ry / 2)) / ry;
  const ncx = point.x + nx * (0.5 - ux);
  const ncy = point.y + ny * (0.5 - uy);
  return {
    zoom: nextZoom,
    pan: clampPan(
      nx === 1 ? 0 : (2 * (ncx - 0.5)) / (nx - 1),
      ny === 1 ? 0 : (2 * (ncy - 0.5)) / (ny - 1),
    ),
  };
}

// Decodes the picked file. The bytes are read into a data: URL (allowed by the img-src
// CSP) and decoded with an <img> element: universal, and avoids the createImageBitmap
// quirk where picker-provided File objects sometimes refuse to decode.
async function loadImage(file: File): Promise<CropImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('file read failed'));
    reader.readAsDataURL(file);
  });
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = dataUrl;
  });
}

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

  // Preview frame size in CSS pixels, bound onto the dialog (the #cropFrame template
  // reference carries the element, so the constant lives under a different name).
  readonly frameSize = FRAME;
  readonly maxZoom = MAX_ZOOM;
  readonly zoomStep = ZOOM_STEP;
  // Kept as a property: a bare object literal in a template is parsed as ICU syntax.
  readonly center = CENTER;

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('cropCanvas') cropCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('cropFrame') cropFrame?: ElementRef<HTMLDivElement>;

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
  cropLoading = false; // decoding the picked file
  cropError = '';
  // Zoom shown on the slider, mirrored from the view so tiny drags don't re-render.
  private lastZoomUI = 1;
  // Live pointers and the gesture they describe (one = pan, two = pinch).
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private wheelTarget: Element | null = null;

  // Repaints the preview and re-attaches the wheel listener once the dialog is in the
  // DOM: the canvas only exists while `cropping()` is true, so a plain call at file
  // selection would otherwise draw into nothing (the old bug: blank preview).
  private readonly cropDialog = effect(() => {
    if (!this.cropping()) return;
    requestAnimationFrame(() => {
      this.paint();
      this.attachWheel();
    });
  });

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

  // Loads the chosen file into the crop dialog, starting from the full cover view.
  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow picking the same file again after cancelling
    if (!file) return;
    this.error = '';
    this.cropError = '';
    this.cropLoading = true;
    this.cropping.set(true);
    try {
      const image = await loadImage(file);
      this.crop = { image, view: { zoom: 1, pan: { x: 0, y: 0 } } };
      this.lastZoomUI = 1;
    } catch (err) {
      console.error('Avatar crop: image decode failed', err);
      this.cropError = this.i18n.t('profile.crop_decode_error');
    } finally {
      this.cropLoading = false;
      this.refresh();
    }
  }

  // Slider value == the current zoom.
  get zoomLevel(): number {
    return this.crop?.view.zoom ?? 1;
  }

  // Slider input: zoom to the requested level, keeping the centre fixed.
  zoomTo(zoom: number): void {
    const state = this.crop;
    if (!state) return;
    this.zoomBy(clampZoom(zoom) / state.view.zoom, CENTER);
  }

  // Multiplies the zoom by a factor, anchored on a frame point (0..1).
  zoomBy(factor: number, point: { x: number; y: number }): void {
    const state = this.crop;
    if (!state) return;
    this.setView(zoomAtPointer(state.image, state.view.zoom, state.view.pan, clampZoom(state.view.zoom * factor), point));
  }

  // Back to the full cover view: image centred at zoom 1.
  resetCrop(): void {
    const state = this.crop;
    if (state) this.setView({ zoom: 1, pan: { x: 0, y: 0 } });
  }

  // Moves the image by `dx`/`dy` frame pixels (the image follows the pointer).
  private panBy(dx: number, dy: number): void {
    const state = this.crop;
    if (!state) return;
    const { zoom, pan } = state.view;
    const rect = cropRect(state.image, FRAME, zoom, pan);
    const next = clampPan(
      pan.x + dx / Math.max(1, (rect.w - FRAME) / 2),
      pan.y + dy / Math.max(1, (rect.h - FRAME) / 2),
    );
    this.setView({ zoom, pan: next });
  }

  // Position of a clientX/clientY inside the frame, as fractions (0..1).
  private framePoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.cropFrame?.nativeElement.getBoundingClientRect();
    if (!rect || rect.width === 0) return { ...CENTER };
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }

  // One pointer drags (pan), a second one added pinches (zoom anchored on the midpoint).
  onPointerDown(event: PointerEvent): void {
    if (!this.crop) return;
    event.currentTarget as HTMLElement;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.gesture = this.readGesture();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.crop || !this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const previous = this.gesture;
    const now = this.readGesture();
    this.gesture = now;
    if (!now || !previous) return;
    if (now.count === 2 && previous.count === 2 && previous.dist && previous.dist > 0) {
      this.zoomBy(now.dist! / previous.dist, this.framePoint(now.x, now.y));
    } else if (now.count === 1 && previous.count === 1) {
      this.panBy(now.x - previous.x, now.y - previous.y);
    }
  }

  onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    this.gesture = this.readGesture();
  }

  // The gesture a set of pointers describes: pan with one, pinch with two.
  private readGesture(): Gesture | null {
    const points = [...this.pointers.values()];
    if (points.length === 0) return null;
    if (points.length === 1) return { count: 1, x: points[0].x, y: points[0].y };
    const [a, b] = points;
    return {
      count: 2,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  // Wheel = zoom at the cursor. Attached natively because Angular binds wheel events as
  // passive, which would make preventDefault (and blocking the page scroll behind the
  // dialog) a no-op.
  private attachWheel(): void {
    const frame = this.cropFrame?.nativeElement;
    if (!frame || frame === this.wheelTarget) return;
    this.wheelTarget?.removeEventListener('wheel', this.onWheel);
    frame.addEventListener('wheel', this.onWheel, { passive: false });
    this.wheelTarget = frame;
  }

  private readonly onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    event.preventDefault();
    const point = this.framePoint(wheel.clientX, wheel.clientY);
    this.zoomBy(wheel.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, point);
  };

  // Keyboard: arrows nudge the image (the image follows the key direction), +/− zoom,
  // Enter applies, Escape closes. The frame is made focusable from the template.
  onCropKey(event: KeyboardEvent): void {
    const nudge = event.shiftKey ? 24 : 8;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-nudge, 0],
      ArrowRight: [nudge, 0],
      ArrowUp: [0, -nudge],
      ArrowDown: [0, nudge],
    };
    if (moves[event.key]) {
      event.preventDefault();
      this.panBy(moves[event.key][0], moves[event.key][1]);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.zoomBy(ZOOM_STEP, CENTER);
    } else if (event.key === '-') {
      event.preventDefault();
      this.zoomBy(1 / ZOOM_STEP, CENTER);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void this.applyCrop();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelCrop();
    }
  }

  cancelCrop(): void {
    this.cropping.set(false);
    this.crop = null;
    this.cropError = '';
    this.pointers.clear();
    this.gesture = null;
  }

  // Exports the current view to a square avatar and uploads it. The export goes through
  // the same cropRect as the preview, so what the user sees is what gets saved.
  async applyCrop(): Promise<void> {
    const state = this.crop;
    if (!state || this.uploading) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = cropRect(state.image, OUTPUT_SIZE, state.view.zoom, state.view.pan);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.image, rect.x, rect.y, rect.w, rect.h);
    const image = canvas.toDataURL('image/webp', 0.85);

    this.uploading = true;
    this.error = '';
    try {
      const body = await this.post<ProfileUpdate>('/api/profile/avatar', { image });
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

  // Draws the current view with the device-pixel ratio, so the preview is crisp on
  // retina screens while the export below still renders at exactly OUTPUT_SIZE.
  private paint(): void {
    const canvas = this.cropCanvas?.nativeElement;
    const state = this.crop;
    if (!canvas || !state) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(FRAME * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, FRAME, FRAME);
    const rect = cropRect(state.image, FRAME, state.view.zoom, state.view.pan);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.image, rect.x, rect.y, rect.w, rect.h);
  }

  // Applies a view, repaints immediately (drag at 60fps) and only re-renders the slider
  // when the zoom actually moved.
  private setView(next: CropView): void {
    if (!this.crop) return;
    this.crop.view = next;
    this.paint();
    if (Math.abs(next.zoom - this.lastZoomUI) >= 0.001) {
      this.lastZoomUI = next.zoom;
      this.refresh();
    }
  }

  // The API returns messages already translated server-side, so show them verbatim.
  private async apiError(res: Response): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || this.i18n.t('common.cancel');
  }
}