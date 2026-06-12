import express from 'express';
import { getScenarioList, getScenarioHistory, getScenarioHistoryCount, getScenarioPassedRunCount } from './storage';
import { escapeHtml, parseDaysParam } from './helpers';
import logger from './logger';

// Renders a public-facing HTML status page for a single scenario (no auth required).
export function handlePublicScenarioStatus(req: express.Request, res: express.Response): void {
  try {
    const list = getScenarioList();
    const scenario = list.find(s => s.name === req.params.name);
    if (!scenario) {
      res.status(404).type('html').send('<html><body style="font-family:sans-serif;padding:2rem;background:#0a0e14;color:#e6edf3"><h1>404</h1><p>Scenario not found</p></body></html>');
      return;
    }

    const days = parseDaysParam(req.query.days as string);
    const history = getScenarioHistory(scenario.name, days);
    const total = getScenarioHistoryCount(scenario.name, days);
    const passed = getScenarioPassedRunCount(scenario.name, days);
    const sla = total > 0 ? Math.round((passed / total) * 1000) / 10 : 100;

    const labelsJson = JSON.stringify(history.map(r => new Date(r.started_at).toLocaleString()).reverse());
    const durationsJson = JSON.stringify(history.map(r => r.duration_ms).reverse());
    const successJson = JSON.stringify(history.map(r => (r.success ? 1 : 0)).reverse());

    const tagHtml = scenario.tags?.length
      ? scenario.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
      : '';

    const hasData = history.length > 0;

    res.type('html').send(publicStatusTemplate({
      name: scenario.name,
      lastSuccess: scenario.last_success,
      sla, days, total, passed,
      tagHtml, labelsJson, durationsJson, successJson, hasData,
    }));
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to render scenario public status page');
    res.status(500).type('text').send('Internal server error');
  }
}

// Public API endpoint that returns scenario run data in JSON format (no auth required).
export function handlePublicScenarioApi(req: express.Request, res: express.Response): void {
  try {
    const list = getScenarioList();
    const scenario = list.find(s => s.name === req.params.name);
    if (!scenario) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }
    const days = parseDaysParam(req.query.days as string);
    const history = getScenarioHistory(scenario.name, days);
    const total = getScenarioHistoryCount(scenario.name, days);
    const passed = getScenarioPassedRunCount(scenario.name, days);
    const sla = total > 0 ? Math.round((passed / total) * 1000) / 10 : 100;
    res.json({
      name: scenario.name,
      last_run: scenario.last_run,
      last_success: scenario.last_success,
      last_duration_ms: scenario.last_duration_ms,
      total_runs: total,
      passed_runs: passed,
      failed_runs: total - passed,
      sla,
      tags: scenario.tags || [],
      history: history.slice(0, 20),
    });
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to serve public scenario API');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Data payload passed to the public status HTML template for rendering.
interface PublicStatusData {
  name: string;
  lastSuccess: number | null;
  sla: number;
  days: number;
  total: number;
  passed: number;
  tagHtml: string;
  labelsJson: string;
  durationsJson: string;
  successJson: string;
  hasData: boolean;
}

// Renders the full HTML page for the public scenario status endpoint.
// Contains inline CSS and Chart.js-powered graphs for duration and success-rate trends.
function publicStatusTemplate(d: PublicStatusData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.name)} — Scenarii Status</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0e14; color: #e6edf3; display: flex; flex-direction: column; min-height: 100vh; }
  .container { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; width: 100%; }
  h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: .25rem; display: flex; align-items: center; gap: .5rem; }
  .subtitle { font-size: .85rem; color: #8b949e; margin-bottom: 1.5rem; }
  .stats { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.5rem; text-align: center; flex: 1; min-width: 100px; }
  .stat-value { font-size: 1.6rem; font-weight: 700; line-height: 1.2; }
  .stat-label { font-size: .75rem; text-transform: uppercase; color: #8b949e; margin-top: .25rem; }
  .ok { color: #3fb950; }
  .fail { color: #f85149; }
  .muted { color: #8b949e; }
  .chart-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; height: 280px; }
  .chart-box h3 { font-size: .75rem; text-transform: uppercase; color: #8b949e; margin-bottom: .75rem; }
  .chart-box canvas { width: 100% !important; height: calc(100% - 1.5rem) !important; }
  .tag { display: inline-block; padding: .1em .5em; border-radius: 999px; font-size: .7rem; background: rgba(88,166,255,.12); color: #58a6ff; margin-right: .25rem; }
  .footer { margin-top: auto; text-align: center; padding: 1.5rem; color: #484f58; font-size: .8rem; border-top: 1px solid #21262d; }
  .no-data { text-align: center; padding: 3rem; color: #484f58; }
  @media (prefers-color-scheme: light) {
    body { background: #fff; color: #1f2328; }
    .stat { background: #f6f8fa; border-color: #d0d7de; }
    .chart-box { background: #f6f8fa; border-color: #d0d7de; }
    .footer { border-color: #d0d7de; color: #656d76; }
  }
</style>
</head>
<body>
<div class="container">
  <h1>
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    ${escapeHtml(d.name)}
  </h1>
  <div class="subtitle">${d.tagHtml} &middot; Status page — auto-refreshes every 30s</div>
  <div class="stats">
    <div class="stat"><div class="stat-value ${d.lastSuccess === 1 ? 'ok' : d.lastSuccess === 0 ? 'fail' : ''}">${d.lastSuccess === 1 ? 'Pass' : d.lastSuccess === 0 ? 'Fail' : '—'}</div><div class="stat-label">Current Status</div></div>
    <div class="stat"><div class="stat-value ${d.sla >= 99 ? 'ok' : d.sla >= 90 ? '' : 'fail'}">${d.sla}%</div><div class="stat-label">SLA (${d.days}d)</div></div>
    <div class="stat"><div class="stat-value">${d.total}</div><div class="stat-label">Total Runs</div></div>
    <div class="stat"><div class="stat-value ok">${d.passed}</div><div class="stat-label">Passed</div></div>
    <div class="stat"><div class="stat-value fail">${d.total - d.passed}</div><div class="stat-label">Failed</div></div>
  </div>
  ${d.hasData ? `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:2rem">
    <div class="chart-box"><h3>Response Time Trend</h3><canvas id="durationChart"></canvas></div>
    <div class="chart-box"><h3>Success Rate Over Time</h3><canvas id="successChart"></canvas></div>
  </div>
  <script>
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const gridColor = isDark ? '#4a5568' : '#d0d7de';
    const textColor = isDark ? '#8b949e' : '#656d76';
    const accent = isDark ? '#00d4ff' : '#6366f1';
    const green = isDark ? '#3fb950' : '#10b981';

    function runningAverage(data, window) {
      return data.map(function(v, i) {
        var start = Math.max(0, i - window + 1);
        var slice = data.slice(start, i + 1);
        return slice.reduce(function(a,b) { return a + b; }, 0) / slice.length;
      });
    }

    function areaGradient(color, alphaTop, alphaBottom) {
      alphaTop = alphaTop || 0.25;
      alphaBottom = alphaBottom || 0.02;
      return function(ctx) {
        var chart = ctx.chart;
        var canvasCtx = chart.ctx;
        var chartArea = chart.chartArea;
        if (!chartArea) return null;
        var grad = canvasCtx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
        var r = parseInt(color.slice(1, 3), 16);
        var g = parseInt(color.slice(3, 5), 16);
        var b = parseInt(color.slice(5, 7), 16);
        grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + alphaBottom + ')');
        grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',' + alphaTop + ')');
        return grad;
      };
    }

    new Chart('durationChart', {
      type: 'line',
      data: {
        labels: ${d.labelsJson},
        datasets: [{ label: 'Duration (ms)', data: ${d.durationsJson}, borderColor: accent, backgroundColor: areaGradient(accent), fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 2 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } }, y: { beginAtZero: true, ticks: { font: { size: 10 }, color: textColor }, grid: { color: gridColor } } } }
    });

    new Chart('successChart', {
      type: 'line',
      data: {
        labels: ${d.labelsJson},
        datasets: [{ label: 'Success', data: runningAverage(${d.successJson}, 5), borderColor: green, backgroundColor: areaGradient(green), fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 2 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 10 }, color: textColor }, grid: { color: gridColor } }, y: { min: 0, max: 1, ticks: { font: { size: 10 }, color: textColor, callback: function(v) { return v * 100 + '%'; } }, grid: { color: gridColor } } } }
    });
  </script>` : '<div class="no-data">No runs yet</div>'}
</div>
<div class="footer">Scenarii — <a href="https://giwi.fr" style="color:#58a6ff">GiwiSoft</a></div>
<script>setTimeout(function(){ location.reload(); }, 30000);</script>
</body>
</html>`;
}
