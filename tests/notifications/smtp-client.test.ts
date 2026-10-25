import { describe, it } from 'node:test';
import assert from 'node:assert';
import { quotedPrintable } from '../../src/notifications/smtp-client';

// Minimal decoder used to assert round-trips: unfold soft breaks, then decode =XX.
function decodeQuotedPrintable(value: string): string {
  const unfolded = value.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (ch === '=') {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === '\r' && unfolded[i + 1] === '\n') {
      bytes.push(0x0d, 0x0a);
      i++;
    } else {
      bytes.push(unfolded.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

describe('quotedPrintable', () => {
  it('keeps printable ASCII literal', () => {
    assert.strictEqual(quotedPrintable('Hello, world!'), 'Hello,=20world!');
  });

  it('encodes equals, spaces and tabs', () => {
    assert.strictEqual(quotedPrintable('a=b c\t'), 'a=3Db=20c=09');
  });

  it('encodes non-ASCII bytes as UTF-8', () => {
    assert.strictEqual(quotedPrintable('é'), '=C3=A9');
  });

  it('returns an empty string for empty input', () => {
    assert.strictEqual(quotedPrintable(''), '');
  });

  it('preserves hard line breaks as CRLF', () => {
    assert.strictEqual(quotedPrintable('a\nb\r\nc'), 'a\r\nb\r\nc');
  });

  it('keeps every line within 76 characters and round-trips', () => {
    const input = `Line one with spaces\tand tabs\n${'x'.repeat(300)}\nDot .line = equals é ü 🎉\r\nEnd`;
    const encoded = quotedPrintable(input);
    for (const line of encoded.split('\r\n')) {
      assert.ok(line.length <= 76, `line too long: ${line.length}`);
    }
    assert.ok([...encoded].every(ch => ch.charCodeAt(0) < 128), 'output must be 7-bit');
    // Quoted-printable normalises line breaks to CRLF, as email requires.
    assert.strictEqual(decodeQuotedPrintable(encoded), input.replace(/\r\n|\r|\n/g, '\r\n'));
  });
});
