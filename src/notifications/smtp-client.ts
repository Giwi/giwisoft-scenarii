import net from 'net';
import tls from 'tls';
import os from 'os';
import type { SmtpConfig } from '../config/settings';

// Minimal SMTP client: enough to submit a single plain-text message over a relay with
// optional AUTH LOGIN and TLS (implicit SMTPS or STARTTLS). No external dependency, in
// line with the other hand-rolled notification senders.

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

// RFC 5322 message: headers + blank line + body. Body is CRLF-normalised and dot-stuffed.
function buildMessage(from: string, to: string[], subject: string, text: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
  ];
  for (const raw of text.split(/\r?\n/)) {
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

// Wraps a socket with line-oriented reply parsing and command sending.
class SmtpConnection {
  private socket: AnySocket;
  private host: string;
  private buffer = '';

  constructor(socket: AnySocket, host: string) {
    this.socket = socket;
    this.host = host;
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
        resolve();
      });
      secured.once('error', reject);
    });
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

    const ehlo = await conn.command(`EHLO ${os.hostname() || 'localhost'}`, 250);
    if (!implicitTls && /STARTTLS/i.test(ehlo)) {
      await conn.command('STARTTLS', 220);
      await conn.upgradeToTls(trust);
      await conn.command(`EHLO ${os.hostname() || 'localhost'}`, 250);
    }

    if (smtp.username) {
      await conn.authLogin(smtp.username, smtp.password ?? '');
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
