import crypto from 'crypto';
import { getProfile } from './users';

// ── Avatars ─────────────────────────────────────────────────────────────────
// The browser crops and scales an uploaded image to a square before sending it, so the
// server only stores bytes. Without an upload the profile falls back to Gravatar.

// Avatars the server is willing to store.
export const AVATAR_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// A cropped 256px image is well under this; the limit only stops abusive payloads.
export const MAX_AVATAR_BYTES = 512 * 1024;

// Basic email sanity check: one @, something on both sides, no spaces.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Gravatar URL for an email (MD5 of the trimmed lowercase address), or undefined when
// there is no email to derive one from.
export function gravatarUrl(email: string | null, size = 96): string | undefined {
  if (!email) return undefined;
  const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
}

// The avatar URL for a user: the uploaded image when there is one, Gravatar otherwise, and
// null when there is neither (no upload and no email to derive a Gravatar from).
export function avatarUrlFor(username: string, size = 96): string | null {
  const profile = getProfile(username);
  if (profile.has_avatar) return `/api/profile/avatar/${encodeURIComponent(username)}?s=${size}`;
  return gravatarUrl(profile.email, size) ?? null;
}

// Reads a `data:<mime>;base64,<payload>` body into a validated Buffer.
export function decodeDataUrl(dataUrl: unknown): { mime: string; bytes: Buffer } | null {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!AVATAR_MIME[mime]) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) return null;
  return { mime, bytes };
}

// True when a data URL payload is an image we accept but that is over the size limit,
// so the caller can tell "too large" from "unsupported format".
export function isOversizedDataUrl(dataUrl: unknown): boolean {
  return typeof dataUrl === 'string' && /^data:image\//.test(dataUrl.trim()) && dataUrl.length > MAX_AVATAR_BYTES;
}