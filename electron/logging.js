import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REDACTED_KEYS = /authorization|cookie|password|secret|token|key|credential/i;

function safeValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.slice(0, 4096),
      stack: typeof value.stack === 'string' ? value.stack.slice(0, 16_384) : undefined,
    };
  }
  if (typeof value === 'string') return value.slice(0, 16_384);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => safeValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entry]) => [key, REDACTED_KEYS.test(key) ? '[redacted]' : safeValue(entry, depth + 1)]),
    );
  }
  return String(value);
}

export class JsonLogger {
  constructor(logDirectory) {
    this.logDirectory = logDirectory;
    this.mainLog = path.join(logDirectory, 'main.jsonl');
    this.crashLog = path.join(logDirectory, 'crashes.jsonl');
    mkdirSync(logDirectory, { recursive: true });
  }

  info(event, details = {}) {
    this.#write(this.mainLog, 'info', event, details);
  }

  warn(event, details = {}) {
    this.#write(this.mainLog, 'warn', event, details);
  }

  error(event, details = {}) {
    this.#write(this.mainLog, 'error', event, details);
  }

  crash(event, details = {}) {
    this.#write(this.crashLog, 'fatal', event, details);
  }

  #write(file, level, event, details) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      details: safeValue(details),
    };
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging is best-effort and must not recurse into another failure.
    }
  }
}

export function installProcessCrashCapture({ logger, shutdown }) {
  process.on('unhandledRejection', (reason) => {
    logger.crash('unhandled_rejection', { reason });
  });
  process.on('uncaughtException', (error) => {
    logger.crash('uncaught_exception', { error });
    void shutdown('uncaught_exception').finally(() => process.exit(1));
  });
}
