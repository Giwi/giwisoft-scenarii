import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { loadSettings } from '../src/config/settings';
import { initStorage, closeStorage } from '../src/config/storage';
import { createApp } from '../src/routes/server';
import {
  verifyGithubSignature,
  verifyGitlabToken,
  parseGithubEvent,
  parseGitlabEvent,
  matchesRule,
} from '../src/routes/webhooks';

const secret = 'test-secret';

function githubSignature(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('webhook signature checks', () => {
  it('accepts a valid GitHub HMAC and rejects tampering', () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = githubSignature(body.toString());
    assert.strictEqual(verifyGithubSignature(secret, body, sig), true);
    assert.strictEqual(verifyGithubSignature(secret, Buffer.from('{"hello":"tampered"}'), sig), false);
    assert.strictEqual(verifyGithubSignature(secret, body, undefined), false);
  });

  it('compares GitLab secret tokens exactly', () => {
    assert.strictEqual(verifyGitlabToken(secret, secret), true);
    assert.strictEqual(verifyGitlabToken(secret, 'nope'), false);
    assert.strictEqual(verifyGitlabToken(secret, undefined), false);
  });
});

describe('webhook payload normalization', () => {
  it('normalizes GitHub push events', () => {
    const event = parseGithubEvent('push', {
      repository: { full_name: 'acme/web' },
      ref: 'refs/heads/main',
      after: 'abc123',
    });
    assert.strictEqual(event.event, 'push');
    assert.strictEqual(event.repository, 'acme/web');
    assert.strictEqual(event.branch, 'main');
    assert.strictEqual(event.sha, 'abc123');
  });

  it('normalizes GitHub pull request events', () => {
    const event = parseGithubEvent('pull_request', {
      action: 'opened',
      repository: { full_name: 'acme/web' },
      pull_request: {
        number: 7,
        head: { ref: 'feature/login', sha: 'def456' },
        base: { ref: 'main' },
      },
    });
    assert.strictEqual(event.event, 'pull_request');
    assert.strictEqual(event.branch, 'feature/login');
    assert.strictEqual(event.target_branch, 'main');
    assert.strictEqual(event.pr, 7);
  });

  it('normalizes GitLab push and merge request events', () => {
    const push = parseGitlabEvent('Push Hook', {
      object_kind: 'push',
      project: { path_with_namespace: 'acme/web' },
      ref: 'refs/heads/main',
      after: 'abc123',
    });
    assert.strictEqual(push.event, 'push');
    assert.strictEqual(push.branch, 'main');

    const mr = parseGitlabEvent('Merge Request Hook', {
      object_kind: 'merge_request',
      project: { path_with_namespace: 'acme/web' },
      object_attributes: {
        action: 'open',
        iid: 9,
        source_branch: 'feature/login',
        target_branch: 'main',
        last_commit: { id: 'def456' },
      },
    });
    assert.strictEqual(mr.event, 'merge_request');
    assert.strictEqual(mr.pr, 9);
    assert.strictEqual(mr.target_branch, 'main');
  });
});

describe('webhook rule matching', () => {
  const push = parseGithubEvent('push', {
    repository: { full_name: 'acme/web' },
    ref: 'refs/heads/release/1.0',
    after: 'abc',
  });

  it('matches provider, repository, event and branch globs', () => {
    assert.strictEqual(matchesRule({
      provider: 'github',
      repository: 'acme/web',
      events: ['push'],
      branches: ['release/*'],
      scenario: 'preview',
    }, push), true);
  });

  it('rejects mismatched repository, event or branch', () => {
    assert.strictEqual(matchesRule({ repository: 'acme/other', scenario: 'x' }, push), false);
    assert.strictEqual(matchesRule({ events: ['pull_request'], scenario: 'x' }, push), false);
    assert.strictEqual(matchesRule({ branches: ['main'], scenario: 'x' }, push), false);
  });
});

describe('webhook HTTP route', () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    loadSettings().webhooks = {
      enabled: true,
      secret,
      rules: [{ provider: 'github', repository: 'acme/web', events: ['push'], scenario: 'preview' }],
    };
    await initStorage(':memory:');
    server = createApp().listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await closeStorage();
  });

  it('rejects an unsigned GitHub delivery', async () => {
    const res = await fetch(`${base}/api/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' },
      body: JSON.stringify({ repository: { full_name: 'acme/web' } }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('answers a signed GitHub ping', async () => {
    const body = JSON.stringify({ repository: { full_name: 'acme/web' } });
    const res = await fetch(`${base}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': githubSignature(body),
      },
      body,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json() as any).status, 'ok');
  });

  it('ignores a signed event with no matching rule', async () => {
    const body = JSON.stringify({ repository: { full_name: 'other/repo' }, ref: 'refs/heads/main' });
    const res = await fetch(`${base}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': githubSignature(body),
      },
      body,
    });
    assert.strictEqual(res.status, 202);
    assert.strictEqual((await res.json() as any).status, 'ignored');
  });
});
