// Prometheus-format metrics exporter for scenario run data and notification delivery stats.

import express from 'express';
import { getScenarioList, getScenarioHistory, getNotificationMetrics } from './storage';
import { escapePrometheusLabel } from './helpers';
import { getSettings } from './settings';
import { DEFAULT_HISTORY_DAYS } from './constants';
import logger from './logger';

// Middleware that enforces Bearer token auth on the /api/metrics endpoint.
export function metricsAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const config = getSettings().api?.auth;
  if (!config?.enabled) return next();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || header.slice(7) !== config.api_key) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Generates and returns Prometheus-format metrics for all scenarios.
export function handleMetrics(_req: express.Request, res: express.Response): void {
  try {
    const list = getScenarioList();
    const lines: string[] = [];

    lines.push('# HELP scenarii_scenario_runs_total Total number of scenario runs');
    lines.push('# TYPE scenarii_scenario_runs_total counter');
    for (const s of list) {
      lines.push(`scenarii_scenario_runs_total{scenario="${escapePrometheusLabel(s.name)}"} ${s.total_runs}`);
    }

    lines.push('');
    lines.push('# HELP scenarii_scenario_duration_ms Latest scenario execution duration in milliseconds');
    lines.push('# TYPE scenarii_scenario_duration_ms gauge');
    for (const s of list) {
      if (s.last_duration_ms !== null) {
        lines.push(`scenarii_scenario_duration_ms{scenario="${escapePrometheusLabel(s.name)}"} ${s.last_duration_ms}`);
      }
    }

    lines.push('');
    lines.push('# HELP scenarii_scenario_success Latest scenario run success (1=pass, 0=fail)');
    lines.push('# TYPE scenarii_scenario_success gauge');
    for (const s of list) {
      if (s.last_success !== null) {
        lines.push(`scenarii_scenario_success{scenario="${escapePrometheusLabel(s.name)}"} ${s.last_success}`);
      }
    }

    lines.push('');
    lines.push('# HELP scenarii_scenario_last_run_seconds Unix timestamp of the last scenario run');
    lines.push('# TYPE scenarii_scenario_last_run_seconds gauge');
    for (const s of list) {
      if (s.last_run) {
        const ts = Math.floor(new Date(s.last_run).getTime() / 1000);
        lines.push(`scenarii_scenario_last_run_seconds{scenario="${escapePrometheusLabel(s.name)}"} ${ts}`);
      }
    }

    const stepLines: string[] = [];
    for (const s of list) {
      try {
        const history = getScenarioHistory(s.name, DEFAULT_HISTORY_DAYS);
        if (history.length > 0) {
          const latest = history[0];
          for (const step of latest.steps) {
            stepLines.push(`scenarii_step_duration_ms{scenario="${escapePrometheusLabel(s.name)}",step="${escapePrometheusLabel(step.step_name)}",action="${escapePrometheusLabel(step.action)}"} ${step.response_time_ms}`);
            stepLines.push(`scenarii_step_success{scenario="${escapePrometheusLabel(s.name)}",step="${escapePrometheusLabel(step.step_name)}",action="${escapePrometheusLabel(step.action)}"} ${step.success ? 1 : 0}`);
          }
        }
      } catch (err: unknown) {
        logger.warn({ scenario: s.name, err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch history for metrics');
      }
    }

    if (stepLines.length > 0) {
      lines.push('');
      lines.push('# HELP scenarii_step_duration_ms Step execution duration in milliseconds');
      lines.push('# TYPE scenarii_step_duration_ms gauge');
      lines.push('');
      lines.push('# HELP scenarii_step_success Step success (1=pass, 0=fail)');
      lines.push('# TYPE scenarii_step_success gauge');
      lines.push(...stepLines);
    }

    const notifMetrics = getNotificationMetrics();
    lines.push('');
    lines.push('# HELP scenarii_notification_delivery_total Total notifications sent');
    lines.push('# TYPE scenarii_notification_delivery_total counter');
    lines.push(`scenarii_notification_delivery_total{status="success"} ${notifMetrics.success}`);
    lines.push(`scenarii_notification_delivery_total{status="failure"} ${notifMetrics.failure}`);

    lines.push('');
    lines.push('# EOF');
    res.type('text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (err: unknown) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).type('text/plain').send('# error: Internal server error\n');
  }
}
