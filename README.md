# scenarii

Execute periodic YAML-defined web test scenarios via a headless browser, store metrics in SQLite, and monitor them on a modern Angular dashboard.

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

- **Scenario list** — overview of all scenarios with pass/fail status, auto-refreshes every 5s
- **Scenario detail** — response time trend chart, success rate over time, step breakdown, full run history
- **Dark/light theme** — toggle with the sun/moon button in the navbar, preference saved to localStorage
- **Manual refresh** — refresh button on both list and detail pages
- **Bootstrap UI** — modern responsive layout with Bootstrap 5 and Bootstrap Icons

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

Scenarios are executed sequentially (Lightpanda CDP supports one connection at a time). Each runs once on startup, then on their `schedule` cron expression.

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

The server looks for `settings.yaml` in the current directory or `/app/settings.yaml` (container). Use `--settings` to specify a custom path. Notifications trigger on state transitions: failure (pass→fail) and recovery (fail→pass).

## Container

```bash
# Build
./build-container.sh
# or
npm run package

# Run
mkdir -p scenarios db
cp settings.example.yaml settings.yaml  # or provide your own settings.yaml
podman run -d \
  --name scenarii \
  -p 3000:3000 \
  -v $(pwd)/scenarios:/scenarios:z \
  -v $(pwd)/db:/app/db:z \
  -v $(pwd)/settings.yaml:/app/settings.yaml:z \
  scenarii:latest
```

The server auto-loads all `.yml`/`.yaml` files from `/scenarios`, runs each once on startup, and schedules them by their `schedule` cron field.

## Tech stack

- **Runtime** — Node.js + TypeScript
- **CLI** — Commander
- **Browser** — Lightpanda headless browser via Playwright CDP
- **Database** — SQLite (better-sqlite3)
- **Scheduling** — node-cron
- **Frontend** — Angular 19 (standalone components), Bootstrap 5, Chart.js
- **Container** — Alpine + multi-stage build
