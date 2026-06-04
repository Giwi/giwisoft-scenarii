# scenarii

Execute periodic YAML-defined web test scenarios, store metrics in SQLite, and view them on a dashboard.

## Quick start

```bash
npm install
npm run build

# Run a scenario once
node dist/index.js --once scenarios/lusk.yml

# Start the server (schedules scenarios + serves dashboard)
node dist/index.js server
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

## Running

```bash
# Development (both API + Angular HMR with one command)
yarn dev

# Or run them separately:
yarn dev:server     # Express API + scenario scheduling on :3000
yarn dev:frontend   # Angular dev server on :4200 with HMR

# Run a scenario once (no server)
yarn dev:once

# Production
npm run build
node dist/index.js server
```

Options for the `server` command:
- `--port <number>` — HTTP port (default: 3000)
- `--db <path>` — SQLite database path (default: `db/scenarii.db`)
- `--scenarios-dir <path>` — directory with `.yml` scenario files (default: `./scenarios`)

## Container

```bash
# Build
./build-container.sh
# or
npm run package

# Run
mkdir -p scenarios db
podman run -d \
  --name scenarii \
  -p 3000:3000 \
  -v $(pwd)/scenarios:/scenarios:z \
  -v $(pwd)/db:/app/db:z \
  scenarii:latest
```

The server auto-loads all `.yml`/`.yaml` files from `/scenarios`, runs each once on startup, and schedules them by their `schedule` cron field.
