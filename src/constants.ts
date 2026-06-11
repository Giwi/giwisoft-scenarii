// Default port for Lightpanda headless browser
export const DEFAULT_LIGHTPANDA_PORT = 9222;
// Default viewport dimensions for browser scenarios
export const DEFAULT_BROWSER_VIEWPORT = { width: 1280, height: 720 };
// Maximum time a scenario can run before being killed
export const DEFAULT_SCENARIO_TIMEOUT = 120_000;
// Retention period in days for purging old run data
export const DEFAULT_PURGE_DAYS = 7;
// Default lookback window for history queries
export const DEFAULT_HISTORY_DAYS = 7;
// Page navigation timeout in milliseconds
export const DEFAULT_PAGE_TIMEOUT = 30000;
// Selector wait timeout in milliseconds
export const DEFAULT_SELECTOR_TIMEOUT = 10000;
// Time to wait for a port to become reachable
export const PORT_WAIT_TIMEOUT = 5000;
// Socket connection timeout for port probes
export const SOCKET_TIMEOUT = 1000;
// Retry interval for socket connection attempts
export const SOCKET_RETRY_INTERVAL = 200;
// Grace period for Lightpanda to exit after kill signal
export const PROCESS_EXIT_TIMEOUT = 3000;
// Cron expression for daily email report
export const DAILY_REPORT_CRON = '0 8 * * *';
// Number of port-allocation retries when starting Lightpanda
export const LIGHTPANDA_START_RETRIES = 3;
// Lowest port number in the random-allocation range
export const MIN_PORT = 9000;
// Spread of port numbers for random allocation
export const PORT_RANGE = 1000;
// Default page size for paginated endpoints
export const DEFAULT_LIMIT = 50;
// Minimum allowed days parameter
export const MIN_DAYS = 1;
// Maximum allowed days parameter
export const MAX_DAYS = 365;
// Relative file-size threshold for screenshot comparison
export const SCREENSHOT_COMPARE_THRESHOLD = 0.01;
// Default consecutive failures before alert triggers
export const DEFAULT_ALERT_CONSECUTIVE_FAILURES = 3;
