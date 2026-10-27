<p align="center">
  <img src="docs/logo.svg" alt="Scenarii" width="300">
</p>

<p align="center">
  Execute periodic YAML-defined web test scenarios via a headless browser (or native HTTP), store metrics in SQLite or PostgreSQL, and monitor them on a modern Dashboard with dark/light themes.
</p>

## Quick start

```bash
npm install
npm run build

# Start the server (schedules scenarios + serves dashboard)
node dist/index.js server

# Or run a scenario once
node dist/index.js --once scenarios/lusk.yml
```

Open http://localhost:3000 to see the dashboard. Each scenario also has a shareable public status page at `/public/status/:name` (no auth required).

## Requirements

- Node.js >= 26 (for Angular 22 and native fetch)
- For browser scenarios: `@lightpanda/browser` (optional - HTTP-only scenarios use native fetch)

## CLI

| Command | Description |
|---------|-------------|
| `server` | Start API server + Dashboard |
| `validate [file]` | Validate a scenario YAML: schema, unknown fields (with suggestions), cron, and action-specific required fields. `--all` checks the scenarios directory; `--json` prints machine-readable results |
| `trigger <file>` | Run a scenario immediately. Exits 1 when the run fails; pass `--fail-on none` to always exit 0 |
| `status` | Show scheduled scenarios and storage status |
| `user <action>` | Manage dashboard users: `list`, `add`, `passwd`, `role`, `del` (also available in the UI at `/users`, admins only) |
| `config --init` | Generate a `settings.yaml` template |

```bash
node dist/index.js validate scenarios/lusk.yml
node dist/index.js validate --all --json   # check every scenario, machine-readable
node dist/index.js trigger scenarios/lusk.yml
node dist/index.js trigger scenarios/lusk.yml --fail-on none   # always exit 0
node dist/index.js status
node dist/index.js user list
node dist/index.js config --init
```

### Server options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port` | `3000` | HTTP port |
| `--db` | auto | SQLite database path or PostgreSQL connection URL (e.g. `postgres://user:pass@host:5432/scenarii`) |
| `--scenarios-dir` | `./scenarios` | Directory with `.yml`/`.yaml` scenario files (watched every 5s - add/remove/rename files without restart) |
| `--settings` | auto-detect | Path to settings file (hot-reloaded, see Notifications below) |

## Writing scenarios

Scenarios are YAML files. HTTP-only steps run in parallel using native fetch; browser steps are serialised (Lightpanda CDP supports one connection at a time). Steps can optionally declare a `timeout` (ms) and a `condition` for conditional execution based on previous step results.

```yaml
name: Example
base_url: https://example.com
variables:                # initial values, resolved before the first step
  API_TOKEN: "{{env.API_TOKEN}}"          # read from the process environment
  API_VERSION: "{{env.API_VERSION:-v1}}"  # fallback when unset or empty
headers:                  # sent with every HTTP step; step headers override
  Authorization: "Bearer {{API_TOKEN}}"
  X-API-Version: "{{API_VERSION}}"
schedule: "*/5 * * * *"   # optional cron expression
timeout: 120000           # per-scenario timeout override (default 120s)
ignoreHTTPSErrors: false  # per-scenario SSL override
tags: [critical, auth]    # optional tags for dashboard filtering
depends_on: "Health check" # optional - skip this scenario if dependency last run failed
group: api                # optional group/category for dashboard filtering
time_windows:             # optional - only run within these time windows
  - start: "09:00"
    end: "17:00"
alert:                    # optional alert rules
  consecutive_failures: 3 # warn after N consecutive failures

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

  - name: Login API
    action: http.post
    url: /api/login
    timeout: 10000            # per-step timeout override
    expect:
      status: 200

  - name: Dashboard check
    action: http.get
    url: /api/dashboard
    condition:                # skip if Login API failed
      if_step: "Login API"
      if_success: true
    expect:
      status: 200

  - name: Login validation
    action: http.post
    url: /api/login
    variables:
      auth_token: $.token     # extract JSON value into {{auth_token}} for later steps
    expect:
      status: 200
      body_schema:            # validate JSON body structure
        type: object
        properties:
          token:
            type: string
        required: [token]

  - include: health-check     # pull in steps from another scenario
```

### HTTP actions

HTTP-only scenarios use the native `fetch` API - no Playwright or browser needed for simple API monitoring.

| Action | Fields |
|--------|--------|
| `http.get` / `http.post` / `http.put` / `http.patch` / `http.delete` | `url`, `headers`, `body`, `expect`, `retries`, `retry_delay` |

**Expectations**: `status`, `status_in`, `body_contains`, `body_matches`, `header_contains` (format `"HeaderName: value"`), `header_matches` (format `"HeaderName: regex"`), `json_path`, `json_value`, `response_time_under`, `body_schema` (JSON body schema: `type` (`object`, `array`, `string`, `number`, `boolean`, `null`), `properties` + `required` for objects, `items` for arrays, `enum`, `pattern`, `min`/`max` for numbers, and `nullable`)

HTTP steps do not retry by default. Set `retries` to retry a failed request or expectation, and `retry_delay` (ms) to control the wait between attempts.

### Browser actions

| Action | Fields |
|--------|--------|
| `browser.navigate` | `url` |
| `browser.fill` | `selector`, `value` |
| `browser.type` | `selector`, `value` |
| `browser.click` | `selector` |
| `browser.wait_for` | `selector`, `timeout`, `expect` (has_text, not_has_text, url_contains) |
| `browser.select` | `selector`, `value` |
| `browser.evaluate` | `script` (JavaScript to run in the page), `variables` (capture return value fields via JSONPath) |
| `browser.check` / `browser.uncheck` | `selector` |
| `browser.hover` | `selector` |
| `browser.clear` | `selector` (clears an input or textarea) |
| `browser.press` | `value` (key, e.g. `Enter`, `Escape`, `Tab`, `Control+A`), optional `selector` to focus first |
| `browser.upload_file` | `selector` (file input), `value` (path on the runner host) |
| `browser.wait_for_response` | `url` (URL pattern with `*` wildcards or a substring), `value` (optional HTTP method), `timeout` |
| `browser.assert` | at least one of `selector` (must be visible), `value` (expected text), or `expect` (has_text, not_has_text, url_contains, selector_count) |
| `browser.screenshot` | `value` (output path) |
| `browser.screenshot_compare` | `value` (baseline path - creates baseline on first run, compares on subsequent) |
| `browser.scroll` | `value` (pixels to scroll down), `selector` (scroll element into view) |

Browser steps automatically retry up to 2 times on failure, waiting `retry_delay` ms (default 1000) between attempts. Override per step with `retries` and `retry_delay`. `browser.evaluate`, `browser.screenshot`, and `browser.screenshot_compare` never retry.

A run is marked **flaky** when any step needed a retry to complete, and each step records its `attempts` count in metrics.

### Variables and secrets

Use `{{variable_name}}` in URLs, headers, bodies, selector values, and expected text. Values can come from three places:

- **Scenario variables** are resolved once before the first step. They can reference process environment variables with `{{env.NAME}}` and other scenario variables by name. Keep tokens out of YAML by reading them from the environment. Because they run first, they cannot reference values extracted by a step.
- **Step variables** extract values from an HTTP response or browser evaluate result using a JSON path. They are available to later steps.
- **Defaults** use shell-style `{{NAME:-fallback}}`. The fallback applies when the value is missing or empty, including env values: `{{env.API_URL:-https://api.example.com}}`.

Scenario `headers` are merged into every HTTP step. Step headers override them by name (case-insensitive), so a single step can replace an inherited `Authorization` header. An unresolved placeholder fails before a request is sent, and the error names the step or scenario variable that failed.

```yaml
variables:
  API_TOKEN: "{{env.API_TOKEN}}"
  API_BASE: "{{env.API_BASE:-https://example.com}}"
base_url: "{{API_BASE}}"

headers:
  Authorization: "Bearer {{API_TOKEN}}"
  Accept: application/json

steps:
  - name: Get token
    action: http.post
    url: /api/login
    variables:
      auth_token: $.token       # store response.token as {{auth_token}}

  - name: Use token
    action: http.get
    url: /api/dashboard?token={{auth_token}}

  - name: Extract from page
    action: browser.evaluate
    script: "{ version: document.querySelector('meta[name=app-version]')?.content }"
    variables:
      app_version: $.version    # store evaluate result.version as {{app_version}}
```

## Dashboard

The dashboard provides:

- **Scenario list** - overview of all scenarios with pass/fail status, tag badges, group badges, tag/group filter dropdowns, depends-on column, auto-refreshes via WebSocket
- **Cross-scenario overview** - pass-rate calendar heatmap, slowest scenarios by p95, flakiest scenarios, and bulk run/pause/resume by tag or group at `/overview`
- **Scenario detail** - response time trend chart, success rate over time, step breakdown, SLA gauge (7-day window), paginated run history, run diff (side-by-side step status, duration delta, error changes), JSON/CSV/YAML export, live ticker (inline step progress in the toolbar), copy public permalink
- **Scenario editor** - click the pencil icon on the detail page to edit a scenario's YAML directly in the browser with syntax highlighting (comments, strings, keys, numbers). "New" opens a blank scenario at `/scenario/new`, "Import" uploads a `.yml`/`.yaml` file and stores it with the others
- **Run Now / Cancel** - trigger an immediate ad-hoc run or abort a running scenario from list or detail
- **Pause/Resume** - toggle scheduled scenarios on/off without deleting files
- **Dark/light theme** - toggle in the navbar, preference saved to localStorage
- **In-app documentation** - `/docs` (navbar link): quickstart, scenario syntax, actions and expectations, authentication and roles, user management, alerts, CLI, and the full API list
- **Dashboard auth** - on by default, local username/password login with an optional OIDC provider; every page is private except the public status pages
- **Manual refresh** - refresh button on both list and detail pages
- **Public status** - per-scenario pages at `/public/status/:name` with stat cards and response time / success rate charts; no auth required
- **Public API** - `GET /api/status` (summary) and `GET /api/public/scenario/:name` (per-scenario detail) - both accessible without auth

## Authentication

Authentication is **enabled by default**; set `auth.enabled: false` to turn it off entirely.

### Local users (no OIDC)

On first start a default user (`admin`) is created with the `admin` role and a generated
password printed once in the server logs:

```
Created default user "admin" with generated password
```

Users have one of two roles:

| Role | Can do |
| --- | --- |
| `admin` | everything a `user` can, plus manage users (add / rename role / reset password / delete) |
| `user` | browse scenarios, view history, trigger and pause runs |

**Only an admin can add a user**, from the dashboard (`/users`, linked in the navbar for admins),
the CLI, or the API:

```bash
scenarii user list                              # list users with their role
scenarii user add bob                           # generate a password, role "user"
scenarii user add carol my-password admin       # explicit password and role
scenarii user passwd bob                        # new generated password
scenarii user role bob admin                    # promote or demote
scenarii user del bob                           # remove a user
```

```bash
curl -X POST http://localhost:3000/api/auth/users \
  -H 'Content-Type: application/json' \
  -b cookies.txt -d '{"username":"dave"}'       # admin session required; password returned once
```

The last remaining admin cannot be deleted: an admin can neither delete their own account nor
change their own role, which is the surest way to lock an install out of user management.

### OIDC

Add an `oidc:` block to `auth` and the provider takes over login. Roles are **inherited
from the provider groups** instead of being stored by hand:

```yaml
auth:
  oidc:
    issuer_url: "https://accounts.google.com"
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    redirect_uri: "http://localhost:3000/api/auth/callback"
    username_claim: "preferred_username"   # claim used as the local username
    groups_claim: "groups"                 # claim holding the group memberships
    admin_group: "scenarii-admins"         # group granting the admin role
```

- `username_claim`: the claim used as the local username. When unset, `preferred_username`,
  then `email`, then `sub` are tried in that order.
- `groups_claim`: the claim read as a group list. Arrays, plain strings, and
  space/comma-separated strings are all accepted; `groups` and `roles` are used as
  fallbacks when unset.
- `admin_group`: membership of this group grants the `admin` role, everyone else gets
  `user`. Without it, every OIDC user is a plain `user`.

The role is re-derived on every login, so adding or removing someone from the group takes
effect on their next sign-in. The local users table is only a mirror of the provider, so
`POST /api/auth/users` is meant for the local setup: with OIDC, identities and roles come
from the provider.

With OIDC the identity provider owns the second factor, so **TOTP is not offered**: the
profile page hides the section and the endpoints refuse the call. Use the provider's own
MFA policy instead.

### Profile, two-factor and recovery

Every user has a profile page (`/profile`, from the navbar avatar) holding:

- **Avatar**: uploaded image, cropped and scaled to a square in the browser. Without an
  upload the avatar comes from Gravatar, derived from the profile email address.
- **Email**: used for Gravatar and for password recovery links.
- **Colour scheme**: light, dark or match the operating system.
- **Language**: `en`, `fr`, `es` or `de`. It applies to the interface *and* to the messages
  the server returns, so a French user reads French errors.
- **Two-factor authentication (TOTP)**: Authy, Google Authenticator, 1Password and
  anything else speaking `otpauth://`. Ten single-use recovery codes are shown once at
  setup. Turning 2FA off requires the password *and* a current code or recovery code.
- **Password**: changing it requires the current password.

**Password recovery** (`Forgot your password?` on the login page) emails a single-use link
valid for one hour. It needs an email channel; without one the link is written to the
server logs:

```yaml
notifications:
  email:
    enabled: true
    from: "scenarii@example.com"
    to: ["admin@example.com"]
    smtp:
      host: smtp.example.com
      port: 587
    # Or use Mailgun: mailgun: { api_key: "key-...", domain: "mg.example.com" }
```

The reply is the same whether or not the account exists, so it cannot be used to discover
usernames. Requests are throttled to 5 per hour per IP.

<p align="center">
  <img src="frontend/public/screenshots/scenario-list.webp" width="45%" alt="Scenario list (light)">
  <img src="frontend/public/screenshots/scenario-list-dark.webp" width="45%" alt="Scenario list (dark)">
  <br>
  <img src="frontend/public/screenshots/scenario-detail.webp" width="45%" alt="Scenario detail (light)">
  <img src="frontend/public/screenshots/scenario-detail-dark.webp" width="45%" alt="Scenario detail (dark)">
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
| `GET /api/scenarios` | List all scenarios with last run status (`?tag=critical`, `?group=api`) |
| `POST /api/scenarios/import` | Import scenario(s) from a YAML string (`{"yaml":"..."}` - single scenario or array). Stored in the scenarios directory, picked up by the scheduler; updates the file when the name already exists (any logged-in user) |
| `GET /api/scenarios/export` | Download all scenarios as a YAML bundle file |
| `GET /api/groups` | List all distinct scenario groups |
| `GET /api/overview` | Cross-scenario stats (`?days=30`): daily pass-rate heatmap, slowest p95, flakiest |
| `POST /api/scenarios/bulk/run` | Trigger all scenarios matching `{tag}` or `{group}` (requires `trigger`) |
| `POST /api/scenarios/bulk/pause` | Pause matching scheduled scenarios (`{tag}` or `{group}`) |
| `POST /api/scenarios/bulk/resume` | Resume matching scheduled scenarios (`{tag}` or `{group}`) |
| `GET /api/runs/:id` | Fetch one persisted run with all steps (requires `read`) |
| `GET /api/runs/:id/diff/:baseId` | Side-by-side diff of two runs: step status, duration delta, error changes |
| `POST /api/webhooks/github` | Inbound GitHub push/PR webhook (HMAC-SHA256 signature, no session) |
| `POST /api/webhooks/gitlab` | Inbound GitLab push/MR webhook (`X-Gitlab-Token`, no session) |
| `GET /api/scenarios/:name` | Scenario detail with paginated run history (`?limit=&offset=&days=`) |
| `GET /api/scenarios/:name/history` | Raw run history (`?limit=&offset=&days=`) |
| `POST /api/scenarios/:name/run` | Trigger an ad-hoc run. `?wait=true` blocks until completion and returns `{status, run_id, metrics}` (requires `trigger`) |
| `POST /api/scenarios/:name/cancel` | Abort a running scenario |
| `POST /api/scenarios/:name/pause` | Pause a scheduled scenario |
| `POST /api/scenarios/:name/resume` | Resume a paused scenario |
| `GET /api/scenarios/:name/config` | Download scenario YAML configuration |
| `PUT /api/scenarios/:name/config` | Save/update scenario YAML (`{"yaml":"..."}`) |
| `DELETE /api/scenarios/:name/config` | Delete a scenario file |
| `GET /api/scenarios/:name/export/json` | Download all history as JSON |
| `GET /api/scenarios/:name/export/csv` | Download all history as CSV |
| `GET /api/scenarios/:name/sla` | SLA calculation (`?days=7`) - returns `{ sla, total_runs, passed_runs, failed_runs }` |
| `POST /api/auth/login` | Local login (`{"username","password"}`) - sets the session cookie, or returns `{requires_2fa, challenge}` when 2FA is on |
| `POST /api/auth/login/2fa` | Second login step (`{"challenge","code"}`) - accepts a TOTP or recovery code, then sets the session cookie |
| `POST /api/auth/password/forgot` | Request a recovery link (`{"identifier"}` = username or email) - same answer either way |
| `POST /api/auth/password/reset` | Apply a recovery token (`{"token","password"}`) - single use |
| `GET /api/auth/oidc` | Redirect to the OIDC provider (requires `auth.oidc` in settings) |
| `GET /api/auth/callback` | OIDC callback - exchanges code for session cookie |
| `GET /api/auth/me` | Return `{ authenticated, username, role, provider, lang, color_scheme, avatar_url }` |
| `POST /api/auth/logout` | Clear session cookie |
| `GET /api/auth/users` | List users with roles (admin only) |
| `POST /api/auth/users` | Create a user (admin only) - generates the password when omitted |
| `PUT /api/auth/users/password` | Change a user's password (admin only) |
| `PUT /api/auth/users/role` | Change a user's role (admin only) |
| `DELETE /api/auth/users/:username` | Delete a user (admin only - an admin cannot delete their own account) |
| `GET /api/profile` | Profile of the current user: email, language, colour scheme, avatar URL, 2FA state |
| `PUT /api/profile` | Update email, language or colour scheme |
| `GET /api/profile/avatar/:username` | Serve a stored avatar (public: the navbar renders it) |
| `POST /api/profile/avatar` | Upload a cropped avatar (`{"image": "data:image/png;base64,..."}`, 512 kB max) |
| `DELETE /api/profile/avatar` | Drop the avatar, falling back to Gravatar |
| `POST /api/profile/password` | Change the current user's password (`{"current_password","new_password"}`) |
| `POST /api/profile/totp/setup` | Start 2FA setup: returns the secret, `otpauth://` URI and QR code |
| `POST /api/profile/totp/enable` | Confirm setup (`{"code"}`) - enables 2FA, returns the recovery codes once |
| `POST /api/profile/totp/disable` | Turn 2FA off (`{"password","code"}` - password plus code or recovery code) |
| `POST /api/backup` | Trigger a manual database backup |
| `GET /api/tags` | List all distinct tags |
| `GET /api/public/scenario/:name` | Public per-scenario JSON detail (no auth required) |
| `GET /api/status` | Public status summary (healthy/unhealthy counts, no auth) |
| `GET /api/health` | Health check (200 = ready, 503 = initializing) |
| `GET /api/metrics` | Prometheus/OpenMetrics format (see below) |

Responses include an `X-Request-Id` header for tracing.

Prometheus can scrape `http://localhost:3000/api/metrics` for:

- `scenarii_scenario_runs_total{scenario}` - total run count
- `scenarii_scenario_duration_ms{scenario}` - latest run duration (ms)
- `scenarii_scenario_success{scenario}` - latest run 1=pass / 0=fail
- `scenarii_scenario_last_run_seconds{scenario}` - last run timestamp
- `scenarii_step_duration_ms{scenario,step,action}` - per-step duration
- `scenarii_step_success{scenario,step,action}` - per-step success
- `scenarii_notification_delivery_total{status}` - notification delivery success/failure count

### Scoped API tokens

Bearer tokens work alongside dashboard sessions. Send `Authorization: Bearer <token>` to any `/api/*` route:

- `read`: list scenarios, fetch run history, `GET /api/runs/:id`, exports, metrics.
- `trigger`: `POST /api/scenarios/:name/run?wait=true`, cancel/pause/resume. Combine with `read` if the caller also needs run history.
- `admin`: import/delete configs, backup, user management, artifact approval. `admin` implies `read` and `trigger`.

When `api.auth.enabled` is true, a token is required for API calls made without a session. Session users keep their existing role-based access. Example CI call:

```bash
curl -X POST -H "Authorization: Bearer $TRIGGER_TOKEN" \
  "https://scenarii.example.com/api/scenarios/smoke/run?wait=true"
# { "status": "passed", "run_id": 42, "metrics": { ... } }
```

## Inbound CI webhooks

Turn Scenarii into a preview-deploy checker: a GitHub or GitLab push / pull request runs a scenario, with the branch, commit, and PR number exposed as variables.

```yaml
webhooks:
  enabled: true
  secret: "YOUR_WEBHOOK_SECRET"
  # Optional fallback scenario when no rule matches.
  # scenario: "smoke"
  rules:
    - provider: github
      repository: "acme/web"
      events: ["push", "pull_request"]
      branches: ["main", "release/*"]   # source or target branch; * wildcard
      scenario: "preview-check"
      variables:
        PREVIEW_URL: "https://preview-{{pr}}.example.com"
```

- GitHub: add a webhook with content type `application/json` and the same secret. The `X-Hub-Signature-256` HMAC over the raw body is verified in constant time.
- GitLab: enable the webhook with the secret token. `X-Gitlab-Token` is compared in constant time.
- Events: GitHub pushes and `pull_request` actions `opened`, `reopened`, `synchronize`, `ready_for_review`; GitLab pushes and merge-request actions `open`, `reopen`, `update`.
- Variables available to the scenario: `WEBHOOK_EVENT`, `WEBHOOK_REPOSITORY`, `WEBHOOK_BRANCH`, `WEBHOOK_TARGET_BRANCH`, `WEBHOOK_SHA`, `WEBHOOK_PR`. Rule variables support `{{repository}}`, `{{branch}}`, `{{target_branch}}`, `{{sha}}`, `{{pr}}`, `{{event}}`, `{{action}}`.
- Responses: `202` accepted/ignored/duplicate, `200` ping, `401` bad signature/token, `404` unknown scenario, `503` secret not configured. Deliveries are deduplicated for 10 minutes.

## Real-time updates

The server exposes a WebSocket endpoint at `/ws`. After each scenario run, a JSON message is broadcast to all connected clients:

```json
{
  "type": "scenario_run",
  "run_id": 42,
  "scenario_name": "Lusk.bzh validation",
  "success": true,
  "duration_ms": 2500,
  "timestamp": "2026-06-06T12:00:00.000Z"
}
```

During a run, **step progress** messages are streamed in real-time. `run_id` is stable from the first step event and matches `GET /api/runs/:id`:

```json
{
  "type": "step_progress",
  "run_id": 42,
  "scenario_name": "Example",
  "step_name": "Homepage",
  "action": "http.get",
  "status": "running",
  "timestamp": "2026-06-06T12:00:00.000Z"
}
```

The dashboard shows a live ticker in the detail toolbar while steps are executing, displaying the current step name, response time, and status icon.

## Notifications

Get alerted when a scenario fails and when it recovers. Create a `settings.yaml` file:

```yaml
api:
  auth:
    enabled: true
    api_key: "YOUR_API_KEY"      # legacy key, treated as an admin-scoped token
    tokens:                      # optional scoped tokens for CI and integrations
      - name: ci-read
        token: "READ_ONLY_TOKEN"
        scopes: ["read"]
      - name: ci-trigger
        token: "TRIGGER_TOKEN"
        scopes: ["trigger"]
      - name: ci-admin
        token: "ADMIN_TOKEN"
        scopes: ["admin"]        # admin implies read + trigger

auth:
  enabled: true                  # dashboard authentication (on by default)
  default_user: admin            # auto-created on first start
  default_user_role: admin       # admin | user
  oidc:                          # OIDC provider configuration (optional)
    issuer_url: "https://accounts.google.com"
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    redirect_uri: "http://localhost:3000/api/auth/callback"
    scopes: "openid profile email"
    username_claim: "preferred_username"   # claim used as the local username
    groups_claim: "groups"                 # claim holding the group memberships
    admin_group: "scenarii-admins"         # group granting the admin role

storage:
  retentionDays: 30              # data retention period (default 7)
  # Backend: 'sqlite' (default) or 'postgres'. A postgres:// connection string
  # selects PostgreSQL; DATABASE_URL is also honoured as a fallback.
  type: sqlite
  # path: ./db/scenarii.db       # SQLite file (when type is sqlite)
  # url: postgres://user:pass@host:5432/scenarii   # when type is postgres
  backup:                        # optional automated backups
    enabled: true
    cron: "0 4 * * *"           # default: daily at 4am
    directory: "./backups"      # default: ./backups

notifications:
  telegram:
    enabled: true
    bot_token: "YOUR_BOT_TOKEN"
    chat_id: "YOUR_CHAT_ID"
  email:
    enabled: true
    from: "scenarii <notifications@YOUR_DOMAIN>"
    to:
      - "admin@example.com"
    # SMTP transport (preferred when configured). tls: true = implicit TLS (SMTPS, 465).
    # Otherwise STARTTLS is used when the server advertises it.
    smtp:
      host: smtp.example.com
      port: 587
      username: "your-username"   # omit both for an unauthenticated relay
      password: "your-password"
      tls: false
      rejectUnauthorized: true    # false only for self-signed relays (insecure)
      # ca: |                     # extra CA certificate (PEM), optional
      #   -----BEGIN CERTIFICATE-----
    # Or use Mailgun instead:
    # mailgun:
    #   api_key: "YOUR_API_KEY"
    #   domain: "YOUR_DOMAIN"
  slack:
    enabled: true
    webhook_url: "https://hooks.slack.com/services/..."
  discord:
    enabled: true
    webhook_url: "https://discord.com/api/webhooks/..."
  webhook:
    enabled: true
    url: "https://your-endpoint/hook"
  teams:
    enabled: true
    webhook_url: "https://outlook.office.com/webhook/..."
  ntfy:
    enabled: true
    url: "https://ntfy.sh"
    topic: "scenarii-alerts"
    # token: "tk_..."          # for protected topics
    priority: 4
  pagerduty:
    enabled: true
    routing_key: "YOUR_EVENTS_V2_ROUTING_KEY"
    severity: critical
  # Global suppression
  muted: false
  maintenance:
    enabled: false
    start: "2026-07-01T22:00:00Z"
    end: "2026-07-01T23:00:00Z"
```

Generic webhooks accept routing and signing options:

```yaml
notifications:
  webhook:
    enabled: true
    url: "https://your-endpoint/hook"
    method: POST                    # POST | PUT | PATCH
    headers:
      X-Environment: "production"
    template: |
      {"text":"{{event}} {{scenario}} ({{duration_ms}}ms)"}
    signing_secret: "YOUR_HMAC_SECRET"
    signing_header: "X-Scenarii-Signature"
    signature_prefix: "sha256="
```

The HMAC is computed over the exact delivered body. Optional templates support `{{scenario}}`, `{{event}}`, `{{success}}`, `{{duration_ms}}`, `{{started_at}}`, `{{finished_at}}`, and `{{steps}}` (JSON).

Secrets can be overridden via environment variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`.

The server looks for `settings.yaml` in the current directory or `/app/settings.yaml` (container). Use `--settings` to specify a custom path. Notifications trigger on state transitions (pass>fail, fail>pass). Notifications include retry logic (3 attempts, exponential backoff).

Channels: Telegram, email (SMTP/Mailgun), Slack, Discord, generic webhook, Microsoft Teams, ntfy, and PagerDuty (Events API v2, with recovery resolving the incident via a stable dedup key). `notifications.muted: true` silences every channel; `notifications.maintenance` suppresses alerts only between the ISO `start` and `end` timestamps.

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

`settings.yaml` is watched for changes and reloaded automatically - no server restart needed.

## Container

### Pre-built image (recommended)

Published on each push to `main`:

```bash
docker pull ghcr.io/giwi/giwisoft-scenarii:latest

mkdir -p scenarios db
cp settings.example.yaml settings.yml  # optional, for notifications
docker run -d \
  --name scenarii \
  -p 3000:3000 \
  -v $(pwd)/scenarios:/scenarios \
  -v $(pwd)/db:/app/db \
  -v $(pwd)/settings.yml:/app/settings.yml:ro \
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
  -v $(pwd)/settings.yml:/app/settings.yml:ro \
  giwisoft-scenarii:latest
```

The container uses `dumb-init` for proper signal handling, runs as non-root (`USER node`), and includes a `HEALTHCHECK` pinging `/api/health` every 30s. Built on `node:26-slim` (glibc) for full Lightpanda compatibility.

> **Rootless podman** - if using rootless podman, mount volumes may be owned by the host user but inaccessible to the container's `node` user. Add `--userns=keep-id` to map the container user to your host UID:
> ```bash
> podman run -d \
>   --name scenarii \
>   --userns=keep-id \
>   -p 3000:3000 \
>   -v $(pwd)/scenarios:/scenarios \
>   -v $(pwd)/db:/app/db \
>   -v $(pwd)/settings.yml:/app/settings.yml:ro \
>   ghcr.io/giwi/giwisoft-scenarii:latest
> ```

### Multi-arch (linux/amd64 + linux/arm64)

Pre-built images support both `amd64` and `arm64`. To build for a specific architecture:

```bash
PLATFORM=linux/arm64 ./build-container.sh
```

To build a multi-arch manifest (requires `docker buildx`):

```bash
PLATFORM=multi ./build-container.sh
```

Or using `make`:

```bash
make build        # linux/amd64 (default)
make build-arm64  # linux/arm64
make build-multi  # multi-arch manifest
```

## Testing

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) - no extra dependencies. Tests cover the sequential execution queue, notification state machine, settings schema validation, URL resolution, variable interpolation, JSON path extraction, YAML parse/serialize, HTTP expectations, and retry logic. Test files live in `tests/` and are compiled via `tests/tsconfig.json` to `dist-test/`.
