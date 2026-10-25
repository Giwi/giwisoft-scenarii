import net from 'net';
import tls from 'tls';
import os from 'os';
import type { SmtpConfig } from '../config/settings';

// Minimal SMTP client: enough to submit a single plain-text message over a relay with
// optional AUTH (PLAIN preferred, LOGIN fallback) and TLS (implicit SMTPS or STARTTLS).
// No external dependency, in line with the other hand-rolled notification senders.

const CRLF = '\r\n';
const SOCKET_TIMEOUT_MS = 30_000;

function messageId(): string {
  return `<${Date.now()}.${Math.random().toString(36).slice(2)}@${os.hostname() || 'localhost'}>`;
}

// RFC 2047 word-encoding for a non-ASCII subject line.
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

// Strips an optional display name, returning the bare address for the envelope.
function envelopeAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

// RFC 2045 quoted-printable: 7-bit safe output, lines at most 76 chars including the
// soft-break '='. Spaces and tabs are always encoded so a soft break can never leave
// trailing whitespace, which the standard forbids.
export function quotedPrintable(text: string): string {
  const bytes = Buffer.from(text, 'utf-8');
  const lines: string[] = [];
  let line = '';

  const append = (token: string) => {
    if (line.length + token.length > 75) {
      lines.push(line + '=');
      line = '';
    }
    line += token;
  };

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d) {
      if (bytes[i + 1] === 0x0a) i++;
      lines.push(line);
      line = '';
      continue;
    }
    if (b === 0x0a) {
      lines.push(line);
      line = '';
      continue;
    }
    const token = b >= 0x21 && b <= 0x7e && b !== 0x3d
      ? String.fromCharCode(b)
      : '=' + b.toString(16).toUpperCase().padStart(2, '0');
    append(token);
  }

  lines.push(line);
  return lines.join(CRLF);
}

// RFC 5322 message: headers + blank line + quoted-printable body, dot-stuffed for DATA.
function buildMessage(from: string, to: string[], subject: string, text: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
  ];
  for (const raw of quotedPrintable(text).split(CRLF)) {
    lines.push(raw.startsWith('.') ? '.' + raw : raw);
  }
  return lines.join(CRLF);
}

type AnySocket = net.Socket | tls.TLSSocket;

// TLS verification settings shared by implicit TLS and STARTTLS connections.
interface TlsTrust {
  rejectUnauthorized: boolean;
  ca?: string;
}

// A servername is only valid for DNS names, not IP literals (RFC 6066).
function serverName(host: string): string | undefined {
  return net.isIP(host) ? undefined : host;
}

// Extracts the AUTH mechanisms advertised in an EHLO reply. Servers write either
// "250-AUTH PLAIN LOGIN" or "250 AUTH=PLAIN LOGIN"; both forms are accepted here.
export function authMechanisms(ehlo: string): string[] {
  for (const line of ehlo.split('\n')) {
    const match = /^\d{3}[ -]AUTH(?:[ =](.*))?$/i.exec(line.trim());
    if (match) {
      return (match[1] ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    }
  }
  return [];
}

// Wraps a socket with line-oriented reply parsing and command sending.
class SmtpConnection {
  private socket: AnySocket;
  private host: string;
  private buffer = '';

  constructor(socket: AnySocket, host: string) {
    this.socket = socket;
    this.host = host;
    this.applyTimeout();
  }

  // Applies the inactivity timeout to the current socket. Called again after STARTTLS
  // because the upgrade wraps the plain socket in a new TLSSocket.
  private applyTimeout(): void {
    this.socket.setTimeout(SOCKET_TIMEOUT_MS, () => this.socket.destroy(new Error('SMTP socket timeout')));
  }

  // Reads one full SMTP reply (all lines of a multi-line reply).
  private readReply(): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8');
        const parts = this.buffer.split(CRLF);
        for (let i = 0; i < parts.length - 1; i++) {
          const line = parts[i];
          if (line.length >= 3 && line[3] !== '-') {
            this.buffer = parts.slice(i + 1).join(CRLF);
            cleanup();
            resolve({ code: Number(line.slice(0, 3)), lines: parts.slice(0, i + 1) });
            return;
          }
        }
      };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('SMTP connection closed')) };
      const cleanup = () => {
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
      };
      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.on('close', onClose);
    });
  }

  async expect(accept: number | number[]): Promise<string> {
    const reply = await this.readReply();
    const codes = Array.isArray(accept) ? accept : [accept];
    if (!codes.includes(reply.code)) {
      throw new Error(`SMTP reply ${reply.code}: ${reply.lines.join(' / ')}`);
    }
    return reply.lines.join('\n');
  }

  async command(cmd: string, accept: number | number[]): Promise<string> {
    this.socket.write(cmd + CRLF);
    return this.expect(accept);
  }

  // Reads the server greeting (first reply after connect).
  async greeting(): Promise<string> {
    return this.expect(220);
  }

  // Sends raw payload (used for the DATA body).
  write(data: string): void {
    this.socket.write(data);
  }

  // Upgrades the live socket to TLS in place (after STARTTLS).
  upgradeToTls(trust: TlsTrust): Promise<void> {
    return new Promise((resolve, reject) => {
      const secured = tls.connect({
        socket: this.socket,
        servername: serverName(this.host),
        rejectUnauthorized: trust.rejectUnauthorized,
        ca: trust.ca,
      });
      secured.once('secureConnect', () => {
        this.socket = secured;
        // The timeout was attached to the plain socket; the TLSSocket needs its own.
        this.applyTimeout();
        resolve();
      });
      secured.once('error', reject);
    });
  }

  // AUTH PLAIN: a single command carrying NUL-separated credentials. Some servers
  // answer the initial response with 334 and wait for the credentials line.
  async authPlain(username: string, password: string): Promise<void> {
    const credentials = Buffer.from(`\0${username}\0${password}`, 'utf-8').toString('base64');
    this.socket.write(`AUTH PLAIN ${credentials}${CRLF}`);
    let reply = await this.readReply();
    if (reply.code === 334) {
      this.socket.write(credentials + CRLF);
      reply = await this.readReply();
    }
    if (reply.code !== 235) {
      throw new Error(`SMTP AUTH PLAIN failed: ${reply.code} ${reply.lines.join(' / ')}`);
    }
  }

  // AUTH LOGIN handshake.
  async authLogin(username: string, password: string): Promise<void> {
    await this.command('AUTH LOGIN', 334);
    await this.command(Buffer.from(username, 'utf-8').toString('base64'), 334);
    await this.command(Buffer.from(password, 'utf-8').toString('base64'), 235);
  }

  close(): void {
    this.socket.end();
  }
}

function connect(host: string, port: number, implicitTls: boolean, trust: TlsTrust): Promise<AnySocket> {
  if (implicitTls) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        servername: serverName(host),
        rejectUnauthorized: trust.rejectUnauthorized,
        ca: trust.ca,
      });
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export async function sendSmtpEmail(
  smtp: SmtpConfig,
  from: string,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const implicitTls = smtp.tls === true;
  const port = smtp.port || (implicitTls ? 465 : 25);
  const trust: TlsTrust = {
    rejectUnauthorized: smtp.rejectUnauthorized !== false,
    ca: smtp.ca,
  };

  const socket = await connect(smtp.host, port, implicitTls, trust);
  const conn = new SmtpConnection(socket, smtp.host);
  try {
    await conn.greeting();

    let ehlo = await conn.command(`EHLO ${os.hostname() || 'localhost'}`, 250);
    if (!implicitTls && /STARTTLS/i.test(ehlo)) {
      await conn.command('STARTTLS', 220);
      await conn.upgradeToTls(trust);
      // Capabilities are re-advertised after the upgrade; use the fresh list.
      ehlo = await conn.command(`EHLO ${os.hostname() || 'localhost'}`, 250);
    }

    if (smtp.username) {
      const mechanisms = authMechanisms(ehlo);
      if (mechanisms.includes('PLAIN')) {
        await conn.authPlain(smtp.username, smtp.password ?? '');
      } else {
        await conn.authLogin(smtp.username, smtp.password ?? '');
      }
    }

    await conn.command(`MAIL FROM:<${envelopeAddress(from)}>`, 250);
    for (const recipient of to) {
      await conn.command(`RCPT TO:<${envelopeAddress(recipient)}>`, [250, 251]);
    }

    await conn.command('DATA', 354);
    conn.write(buildMessage(from, to, subject, text) + CRLF + '.' + CRLF);
    await conn.expect(250);
    await conn.command('QUIT', 221);
  } finally {
    conn.close();
  }
}
