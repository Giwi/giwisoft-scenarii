import crypto from 'crypto';

// ──────────────────────────────────────────
// TOTP (RFC 6238) — Authy / Google Authenticator compatible
// ──────────────────────────────────────────
// HOTP over a 30 second step, HMAC-SHA1, 6 digits, 32 character base32 secret.
// Implemented on node:crypto so no third-party dependency is needed.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

// Base32 (RFC 4648) without padding, as used by authenticator apps.
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Decodes a base32 secret, tolerating lowercase, spaces, dashes and padding.
export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Generates a new shared secret (20 bytes, the size Google Authenticator expects).
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

// Computes the code for a given 8 byte counter value.
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

// The code authenticator apps display right now (used by tests and diagnostics).
export function currentTotpCode(secret: string, at: number = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(at / 1000 / STEP_SECONDS));
}

// Checks a user supplied code against the secret, allowing `window` steps of clock
// drift on either side. Comparison is constant time.
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const trimmed = (code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(trimmed)) return false;
  const secretBuf = base32Decode(secret);
  if (!secretBuf.length) return false;
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  let valid = false;
  for (let drift = -window; drift <= window; drift++) {
    const candidate = hotp(secretBuf, counter + drift);
    if (candidate.length === trimmed.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(trimmed))) {
      valid = true;
    }
  }
  return valid;
}

// The otpauth:// URI authenticator apps import from a QR code.
export function totpUri(secret: string, account: string, issuer = 'Scenarii'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ────────────────────────────────────────────────────────────
// Single-use codes printed when 2FA is enabled, so a lost phone is recoverable.

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'));
}