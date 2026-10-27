// Inbound CI webhooks. GitHub and GitLab push / pull-request events are verified against
// a shared secret, matched against settings.webhooks.rules, and dispatched to a scenario.
// The route is intentionally outside session auth: the signature is the authentication.

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getSettings, WebhookProvider, WebhookRuleConfig } from '../config/settings';
import { loadScenarioFile } from '../config/parser';
import { runScenario, RunOptions } from '../runner/runner';
import { Scenario } from '../types';
import logger from '../utils/logger';

export interface NormalizedWebhook {
  provider: WebhookProvider;
  // push | pull_request | merge_request | ping | other
  event: string;
  action?: string;
  repository: string;
  // Source branch (the pushed ref, or the PR/MR head).
  branch: string;
  // Target branch for PR/MR events; same as `branch` for pushes.
  target_branch: string;
  sha?: string;
  pr?: number;
}

interface WebhookContext {
  scenariosDir?: string;
  runOptions?: RunOptions;
}

// Deduplicates provider retries within a short window.
const seenDeliveries = new Map<string, number>();
const DELIVERY_TTL_MS = 10 * 60 * 1000;

function isDuplicate(req: express.Request, provider: WebhookProvider): boolean {
  const id = (provider === 'github'
    ? req.headers['x-github-delivery']
    : req.headers['x-gitlab-event-uuid']) as string | undefined;
  if (!id) return false;
  const now = Date.now();
  for (const [key, at] of seenDeliveries) {
    if (now - at > DELIVERY_TTL_MS) seenDeliveries.delete(key);
  }
  const key = `${provider}:${id}`;
  if (seenDeliveries.has(key)) return true;
  seenDeliveries.set(key, now);
  return false;
}

function rawBodyOf(req: express.Request): Buffer | undefined {
  const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (raw?.length) return raw;
  // Re-serialize as a fallback; signatures over the exact bytes will not match unless
  // the route is reached without the JSON body parser.
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));
  return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Verifies GitHub's X-Hub-Signature-256 HMAC over the exact request body.
export function verifyGithubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(expected, header.slice('sha256='.length));
}

// Verifies GitLab's secret token. GitLab sends the raw secret, not an HMAC.
export function verifyGitlabToken(secret: string, header: string | undefined): boolean {
  if (!header) return false;
  return timingSafeEqual(secret, header);
}

function stripRef(ref: string | undefined): string {
  if (!ref) return '';
  return ref.replace(/^refs\/heads\//, '');
}

export function parseGithubEvent(event: string | undefined, payload: Record<string, any>): NormalizedWebhook {
  const repository = String(payload.repository?.full_name ?? '');
  const action = typeof payload.action === 'string' ? payload.action : undefined;

  if (event === 'ping') {
    return { provider: 'github', event: 'ping', action, repository, branch: '', target_branch: '' };
  }
  if (event === 'push') {
    const branch = stripRef(payload.ref);
    return {
      provider: 'github',
      event: 'push',
      action,
      repository,
      branch,
      target_branch: branch,
      sha: typeof payload.after === 'string' ? payload.after : undefined,
    };
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request ?? {};
    return {
      provider: 'github',
      event: 'pull_request',
      action,
      repository,
      branch: String(pr.head?.ref ?? ''),
      target_branch: String(pr.base?.ref ?? ''),
      sha: typeof pr.head?.sha === 'string' ? pr.head.sha : undefined,
      pr: typeof pr.number === 'number' ? pr.number : undefined,
    };
  }
  return { provider: 'github', event: event || 'other', action, repository, branch: '', target_branch: '' };
}

export function parseGitlabEvent(header: string | undefined, payload: Record<string, any>): NormalizedWebhook {
  const kind = String(payload.object_kind ?? '').toLowerCase();
  const repository = String(payload.project?.path_with_namespace ?? '');
  const action = typeof payload.object_attributes?.action === 'string' ? payload.object_attributes.action : undefined;

  if (kind === 'push' || header === 'Push Hook') {
    const branch = stripRef(payload.ref);
    return {
      provider: 'gitlab',
      event: 'push',
      action,
      repository,
      branch,
      target_branch: branch,
      sha: typeof payload.after === 'string' ? payload.after : undefined,
    };
  }
  if (kind === 'merge_request' || header === 'Merge Request Hook') {
    const attrs = payload.object_attributes ?? {};
    return {
      provider: 'gitlab',
      event: 'merge_request',
      action,
      repository,
      branch: String(attrs.source_branch ?? ''),
      target_branch: String(attrs.target_branch ?? ''),
      sha: typeof attrs.last_commit?.id === 'string' ? attrs.last_commit.id : undefined,
      pr: typeof attrs.iid === 'number' ? attrs.iid : undefined,
    };
  }
  return { provider: 'gitlab', event: kind || header || 'other', action, repository, branch: '', target_branch: '' };
}

// True for PR/MR actions worth checking in CI (skip edits, labels, closes, merges).
function isRelevantAction(webhook: NormalizedWebhook): boolean {
  if (webhook.event === 'push') return true;
  if (webhook.event === 'pull_request') {
    return ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(webhook.action ?? '');
  }
  if (webhook.event === 'merge_request') {
    return ['open', 'reopen', 'update'].includes(webhook.action ?? '');
  }
  return false;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function matchesRule(rule: WebhookRuleConfig, webhook: NormalizedWebhook): boolean {
  if (rule.provider && rule.provider !== webhook.provider) return false;
  if (rule.repository && rule.repository !== webhook.repository) return false;
  if (rule.events?.length && !rule.events.includes(webhook.event)) return false;
  if (rule.branches?.length) {
    const candidates = [webhook.branch, webhook.target_branch].filter(Boolean);
    if (!candidates.some(branch => rule.branches!.some(pattern => globMatches(pattern, branch)))) {
      return false;
    }
  }
  return true;
}

function expandVariables(template: string, webhook: NormalizedWebhook): string {
  const values: Record<string, string> = {
    repository: webhook.repository,
    branch: webhook.branch,
    target_branch: webhook.target_branch,
    sha: webhook.sha ?? '',
    pr: webhook.pr !== undefined ? String(webhook.pr) : '',
    event: webhook.event,
    action: webhook.action ?? '',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

// Finds the configured scenario for an event. Returns undefined when no rule matches.
export function resolveScenarioName(webhook: NormalizedWebhook): string | undefined {
  const config = getSettings().webhooks;
  const rule = config?.rules?.find(r => matchesRule(r, webhook));
  return rule?.scenario ?? config?.scenario;
}

function findScenario(scenariosDir: string | undefined, name: string): Scenario | undefined {
  if (!scenariosDir) return undefined;
  try {
    const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const scenario = loadScenarioFile(path.join(scenariosDir, file));
      if (scenario.name === name) return scenario;
    }
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to read scenarios directory for webhook');
  }
  return undefined;
}

function scenarioWithWebhookVars(scenario: Scenario, webhook: NormalizedWebhook): Scenario {
  const config = getSettings().webhooks;
  const rule = config?.rules?.find(r => matchesRule(r, webhook));
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule?.variables ?? {})) {
    vars[key] = expandVariables(String(value), webhook);
  }
  scenario.variables = {
    ...(scenario.variables ?? {}),
    ...vars,
    WEBHOOK_EVENT: webhook.event,
    WEBHOOK_REPOSITORY: webhook.repository,
    WEBHOOK_BRANCH: webhook.branch,
    WEBHOOK_TARGET_BRANCH: webhook.target_branch,
    WEBHOOK_SHA: webhook.sha ?? '',
    WEBHOOK_PR: webhook.pr !== undefined ? String(webhook.pr) : '',
  };
  return scenario;
}

export async function handleWebhook(
  provider: WebhookProvider,
  req: express.Request,
  res: express.Response,
  ctx: WebhookContext,
): Promise<void> {
  const config = getSettings().webhooks;
  if (!config?.enabled) {
    res.status(404).json({ error: 'Webhooks are disabled' });
    return;
  }
  if (!config.secret) {
    logger.error({ provider }, 'Webhook secret is not configured');
    res.status(503).json({ error: 'Webhook secret is not configured' });
    return;
  }

  const body = rawBodyOf(req);
  if (!body) {
    res.status(400).json({ error: 'Missing request body' });
    return;
  }

  if (provider === 'github') {
    if (!verifyGithubSignature(config.secret, body, req.headers['x-hub-signature-256'] as string | undefined)) {
      logger.warn({ provider }, 'Rejected webhook with invalid signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  } else if (!verifyGitlabToken(config.secret, req.headers['x-gitlab-token'] as string | undefined)) {
    logger.warn({ provider }, 'Rejected webhook with invalid token');
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  if (isDuplicate(req, provider)) {
    res.status(202).json({ status: 'duplicate' });
    return;
  }

  const payload = (req.body ?? {}) as Record<string, any>;
  const webhook = provider === 'github'
    ? parseGithubEvent(req.headers['x-github-event'] as string | undefined, payload)
    : parseGitlabEvent(req.headers['x-gitlab-event'] as string | undefined, payload);

  if (webhook.event === 'ping') {
    res.json({ status: 'ok', event: 'ping', repository: webhook.repository });
    return;
  }
  if (!isRelevantAction(webhook)) {
    res.status(202).json({ status: 'ignored', reason: 'event action not relevant', event: webhook.event, action: webhook.action });
    return;
  }

  const scenarioName = resolveScenarioName(webhook);
  if (!scenarioName) {
    res.status(202).json({ status: 'ignored', reason: 'no matching rule', event: webhook.event, repository: webhook.repository });
    return;
  }

  const scenario = findScenario(ctx.scenariosDir, scenarioName);
  if (!scenario) {
    logger.error({ scenario: scenarioName, provider }, 'Webhook target scenario not found');
    res.status(404).json({ error: `Scenario "${scenarioName}" not found`, scenario: scenarioName });
    return;
  }

  scenarioWithWebhookVars(scenario, webhook);
  // CI runs are always persisted so providers can fetch the result via /api/runs/:id.
  const options: RunOptions = { ...(ctx.runOptions ?? { headless: true }), persist: true };
  runScenario(scenario, options).catch((err: unknown) => {
    logger.error({ scenario: scenarioName, provider, err: err instanceof Error ? err.message : String(err) }, 'Webhook-triggered run failed');
  });

  logger.info({ provider, scenario: scenarioName, repository: webhook.repository, branch: webhook.branch, event: webhook.event }, 'Webhook triggered scenario');
  res.status(202).json({
    status: 'accepted',
    scenario: scenarioName,
    event: webhook.event,
    action: webhook.action,
    repository: webhook.repository,
    branch: webhook.branch,
    target_branch: webhook.target_branch,
    sha: webhook.sha,
    pr: webhook.pr,
  });
}
