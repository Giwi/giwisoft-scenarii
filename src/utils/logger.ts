import pino from 'pino';

// Shared pino logger with ISO timestamps and configurable log level.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) { return { level: label }; },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
