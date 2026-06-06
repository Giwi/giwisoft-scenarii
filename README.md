# scenarii

Execute periodic YAML-defined web test scenarios via a headless browser, store metrics in SQLite, and monitor them on a modern Angular dashboard with dark/light themes.

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

## Writing scenarios

Scenarios are YAML files. Each step is either an HTTP request or a browser action.

```yaml
name: Example
base_url: https://example.com
schedule: "*/5 * * * *"   # optional cron expression

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

### Variables

Steps can reference values from previous steps using `{{variable_name}}`. Variables are extracted from HTTP responses using the `variables` field with a `json_path` selector.

## Dashboard

The Angular dashboard provides:

- **Scenario list** — overview of all scenarios with pass/fail status, auto-refreshes every 5s via WebSocket
- **Scenario detail** — response time trend chart, success rate over time, step breakdown, full run history
- **Dark/light theme** — toggle with the sun/moon button in the navbar, preference saved to localStorage, favicon adapts to the active theme
- **Manual refresh** — refresh button on both list and detail pages
- **Footer** — © GiwiSoft 2026 with link to https://giwi.fr
- **Bootstrap UI** — modern responsive layout with Bootstrap 5, Bootstrap Icons, and glassmorphism design

![Scenario list (light)](frontend/public/screenshots/scenario-list.png)
![Scenario detail (light)](frontend/public/screenshots/scenario-detail.png)
![Scenario list (dark)](frontend/public/screenshots/scenario-list-dark.png)
![Scenario detail (dark)](frontend/public/screenshots/scenario-detail-dark.png)

## Running

```bash
# Development (both API + Angular HMR with one command)
yarn dev

# Or run them separately:
yarn dev:server     # Express API + scenario scheduling on :3000
yarn dev:frontend   # Angular dev server on :4200 with HMR
yarn dev:once       # Run the lusk scenario once

# Production
npm run build
node dist/index.js server
```

### Server options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `3000` | HTTP port |
| `--db` | `db/scenarii.db` | SQLite database path |
| `--scenarios-dir` | `./scenarios` | Directory with `.yml`/`.yaml` scenario files |
| `--settings` | auto-detect | Path to settings file (see Notifications below) |

Scenarios are executed sequentially (Lightpanda CDP supports one connection at a time). Each runs once on startup, then on their `schedule` cron expression. A per-scenario timeout (default 120s) prevents hung scenarios from blocking the queue indefinitely.

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/scenarios` | List all scenarios with last run status |
| `GET /api/scenarios/:name` | Scenario detail with full run history |
| `GET /api/scenarios/:name/history` | Raw run history for a scenario |
| `GET /api/health` | Health check (200 = ready, 503 = initializing) |
| `GET /api/metrics` | Prometheus/OpenMetrics format (see below) |

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

The dashboard uses this for instant UI updates (list auto-refreshes on any run; detail page refreshes only for the viewed scenario). The 5s polling fallback remains active.

## Notifications

Get alerted when a scenario fails and when it recovers. Create a `settings.yaml` file (use `settings.example.yaml` as a template):

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

The server looks for `settings.yaml` in the current directory or `/app/settings.yaml` (container). Use `--settings` to specify a custom path. Notifications trigger on state transitions: failure (pass→fail) and recovery (fail→pass). Only the first run after a state change sends a notification.

## Container

```bash
# Build
./build-container.sh
# or
npm run package

# Run
mkdir -p scenarios db
cp settings.example.yaml settings.yaml  # optional, for notifications
podman run -d \
  --name scenarii \
  -p 3000:3000 \
  -v $(pwd)/scenarios:/scenarios:z \
  -v $(pwd)/db:/app/db:z \
  -v $(pwd)/settings.yaml:/app/settings.yaml:z \  # optional
  scenarii:latest
```

The container includes a `HEALTHCHECK` that pings `/api/health` every 30s (10s startup grace period, 3 retries). The server auto-loads all `.yml`/`.yaml` files from `/scenarios`, runs each once on startup, and schedules them by their `schedule` cron field.

## CI/CD

On push to `main`, GitHub Actions:

1. Installs dependencies and runs `tsc --noEmit`
2. Executes unit tests (`npm test`)
3. Builds the frontend and backend
4. Builds and publishes the Docker image to `ghcr.io/<owner>/scenarii:latest`

The workflow is in `.github/workflows/ci.yml`.

## Testing

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) — no extra dependencies. Tests cover the sequential execution queue, notification state machine, and settings schema validation.

## Tech stack

- **Runtime** — Node.js + TypeScript
- **CLI** — Commander
- **Browser** — Lightpanda headless browser via Playwright CDP
- **Database** — SQLite (better-sqlite3)
- **Scheduling** — node-cron
- **Notifications** — Telegram Bot API, Mailgun API
- **Frontend** — Angular 19 (standalone components), Bootstrap 5, Chart.js, Bootstrap Icons
- **Container** — Alpine + multi-stage build
