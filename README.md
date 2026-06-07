# scenarii

Execute periodic YAML-defined web test scenarios via a headless browser (or native HTTP), store metrics in SQLite, and monitor them on a modern Angular dashboard with dark/light themes.

## Quick start

```bash
npm install
npm run build

# Start the server (schedules scenarios + serves dashboard)
node dist/index.js server

# Or run a scenario once
node dist/index.js --once scenarios/lusk.yml
```

Open http://localhost:3000 to see the dashboard.

## Requirements

- Node.js ≥ 24.15.0 or ≥ 26.0.0 (for Angular 22)
- For browser scenarios: `@lightpanda/browser` (optional — HTTP-only scenarios use native fetch)

## CLI

| Command | Description |
|---------|-------------|
| `server` | Start API server + Angular dashboard |
| `validate <file>` | Validate a scenario YAML without running it |
| `trigger <file>` | Run a scenario immediately |
| `status` | Show scheduled scenarios and storage status |
| `config --init` | Generate a `settings.yaml` template |

```bash
node dist/index.js validate scenarios/lusk.yml
node dist/index.js trigger scenarios/lusk.yml
node dist/index.js status
node dist/index.js config --init
```

### Server options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port` | `3000` | HTTP port |
| `--db` | `db/scenarii.db` | SQLite database path |
| `--scenarios-dir` | `./scenarios` | Directory with `.yml`/`.yaml` scenario files |
| `--settings` | auto-detect | Path to settings file (see Notifications below) |

## Writing scenarios

Scenarios are YAML files. HTTP-only steps run in parallel using native fetch; browser steps are serialised (Lightpanda CDP supports one connection at a time).

```yaml
name: Example
base_url: https://example.com
schedule: "*/5 * * * *"   # optional cron expression
timeout: 120000           # per-scenario timeout override (default 120s)
ignoreHTTPSErrors: false  # per-scenario SSL override

steps:
  - name: Homepage
    action: http.get
    url: /
    expect:
      status: 200

  - name: Open page
    action: browser.navigate
    url: /

  - name: Click button
    action: browser.click
    selector: "#submit"

  - name: Check result
    action: browser.wait_for
    selector: ".result"
    timeout: 5000
```

### HTTP actions

HTTP-only scenarios use the native `fetch` API — no Playwright or browser needed for simple API monitoring.

| Action | Fields |
|--------|--------|
| `http.get` / `http.post` / `http.put` / `http.patch` / `http.delete` | `url`, `headers`, `body`, `expect` |

**Expectations**: `status`, `status_in`, `body_contains`, `body_matches`, `json_path`, `json_value`, `response_time_under`

### Browser actions

| Action | Fields |
|--------|--------|
| `browser.navigate` | `url` |
| `browser.fill` | `selector`, `value` |
| `browser.type` | `selector`, `value` |
| `browser.click` | `selector` |
| `browser.wait_for` | `selector`, `timeout`, `expect` (has_text, not_has_text, url_contains) |
| `browser.select` | `selector`, `value` |
| `browser.evaluate` | `script` (JavaScript to run in the page) |
| `browser.check` / `browser.uncheck` | `selector` |
| `browser.screenshot` | `value` (output path) |

Browser steps automatically retry up to 2 times with exponential backoff (1s, 2s) on failure.

### Variables

Steps can reference values from previous steps using `{{variable_name}}`. Variables are extracted from HTTP responses using the `variables` field with a `json_path` selector.

## Dashboard

The dashboard provides:

- **Scenario list** — overview of all scenarios with pass/fail status, auto-refreshes via WebSocket
- **Scenario detail** — response time trend chart, success rate over time, step breakdown, paginated run history, **JSON/CSV export** buttons
- **Dark/light theme** — toggle in the navbar, preference saved to localStorage
- **Manual refresh** — refresh button on both list and detail pages

<p align="center">
  <img src="frontend/public/screenshots/scenario-list.png" width="45%" alt="Scenario list (light)">
  <img src="frontend/public/screenshots/scenario-list-dark.png" width="45%" alt="Scenario list (dark)">
  <br>
  <img src="frontend/public/screenshots/scenario-detail.png" width="45%" alt="Scenario detail (light)">
  <img src="frontend/public/screenshots/scenario-detail-dark.png" width="45%" alt="Scenario detail (dark)">
</p>

## Running

```bash
# Development (both API + Angular HMR with one command)
npm run dev

# Or run them separately:
npm run dev:server     # Express API + scenario scheduling on :3000
npm run dev:frontend   # Angular dev server on :4200 with HMR
npm run dev:once       # Run the lusk scenario once

# Production
npm run build
node dist/index.js server
```

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/scenarios` | List all scenarios with last run status |
| `GET /api/scenarios/:name` | Scenario detail with paginated run history (`?limit=&offset=`) |
| `GET /api/scenarios/:name/history` | Raw run history (`?limit=&offset=`) |
| `GET /api/scenarios/:name/export/json` | Download all history as JSON |
| `GET /api/scenarios/:name/export/csv` | Download all history as CSV |
| `GET /api/health` | Health check (200 = ready, 503 = initializing) |
| `GET /api/metrics` | Prometheus/OpenMetrics format (see below) |

Responses include an `X-Request-Id` header for tracing.

Prometheus can scrape `http://localhost:3000/api/metrics` for:

- `scenarii_scenario_runs_total{scenario}` — total run count
- `scenarii_scenario_duration_ms{scenario}` — latest run duration (ms)
- `scenarii_scenario_success{scenario}` — latest run 1=pass / 0=fail
- `scenarii_scenario_last_run_seconds{scenario}` — last run timestamp
- `scenarii_step_duration_ms{scenario,step,action}` — per-step duration
- `scenarii_step_success{scenario,step,action}` — per-step success

## Real-time updates

The server exposes a WebSocket endpoint at `/ws`. After each scenario run, a JSON message is broadcast to all connected clients:

```json
{
  "type": "scenario_run",
  "scenario_name": "Lusk.bzh validation",
  "success": true,
  "duration_ms": 2500,
  "timestamp": "2026-06-06T12:00:00.000Z"
}
```

The dashboard uses this for instant UI updates.

## Notifications

Get alerted when a scenario fails and when it recovers. Create a `settings.yaml` file:

```yaml
notifications:
  telegram:
    enabled: true
    bot_token: "YOUR_BOT_TOKEN"
    chat_id: "YOUR_CHAT_ID"
  email:
    enabled: true
    mailgun:
      api_key: "YOUR_API_KEY"
      domain: "YOUR_DOMAIN"
      from: "scenarii <notifications@YOUR_DOMAIN>"
    to:
      - "admin@example.com"
```

Secrets can be overridden via environment variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`.

The server looks for `settings.yaml` in the current directory or `/app/settings.yaml` (container). Use `--settings` to specify a custom path. Notifications trigger on state transitions (pass→fail, fail→pass). Notifications include retry logic (3 attempts, exponential backoff).

A **daily email report** is automatically sent at 8:00 AM (cron) if email notifications are configured.

### Per-scenario overrides

You can override settings per scenario in `settings.yaml`:

```yaml
scenarios:
  my-scenario:
    ignoreHTTPSErrors: true
    timeout: 60000
    notifications:
      enabled: false
```

### Hot-reload

`settings.yaml` is watched for changes and reloaded automatically — no server restart needed.

## Container

### Pre-built image (recommended)

Published on each push to `main`:

```bash
docker pull ghcr.io/giwi/giwisoft-scenarii:latest

mkdir -p scenarios db
cp settings.example.yaml settings.yaml  # optional, for notifications
docker run -d \
  --name scenarii \
  -p 3000:3000 \
  -v $(pwd)/scenarios:/scenarios \
  -v $(pwd)/db:/app/db \
  -v $(pwd)/settings.yaml:/app/settings.yaml:ro \
  ghcr.io/giwi/giwisoft-scenarii:latest
```

### Build locally

```bash
./build-container.sh
# or
npm run package

docker run -d \
  --name scenarii \
  -p 3000:3000 \
  -v $(pwd)/scenarios:/scenarios \
  -v $(pwd)/db:/app/db \
  -v $(pwd)/settings.yaml:/app/settings.yaml:ro \
  giwisoft-scenarii:latest
```

The container includes a `HEALTHCHECK` that pings `/api/health` every 30s, runs as non-root (`USER node`), and uses `dumb-init` for proper signal handling.

## CI/CD

On push to `main`, GitHub Actions:

1. Installs dependencies and runs `tsc --noEmit`
2. Executes unit tests (`npm test`)
3. Builds the frontend and backend
4. Builds the Docker image with a smoke test and vulnerability scan
5. Publishes the Docker image to **GitHub Container Registry** (tagged `latest` + git SHA)

The workflow is in `.github/workflows/ci.yml`. Dependabot is configured for weekly npm and GitHub Actions updates.

## Testing

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) — no extra dependencies. Tests cover the sequential execution queue, notification state machine, and settings schema validation.

## Tech stack

- **Runtime** — Node.js 26 + TypeScript (strict mode)
- **CLI** — Commander
- **HTTP** — Native `fetch` (no Playwright needed for API monitoring)
- **Browser** — Lightpanda headless browser via Playwright CDP (with retry)
- **Database** — SQLite (better-sqlite3, WAL mode)
- **Scheduling** — node-cron
- **Notifications** — Telegram Bot API, Mailgun API (with retry)
- **Logging** — pino (structured JSON, ISO timestamps)
- **Security** — Helmet (CSP, HSTS, X-Frame-Options, etc.)
- **Frontend** — Angular 22 (standalone components), Bootstrap 5, Chart.js, Bootstrap Icons
- **Container** — Alpine + multi-stage build, non-root user
