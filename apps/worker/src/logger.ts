// Structured logger: one JSON object per line. Agent and request ids travel with child loggers.
// Keys that look like secrets are redacted by name, so callers never need to filter values by hand.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  write?: (line: string, level: LogLevel) => void;
  now?: () => number;
  base?: LogFields;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /private|secret|mnemonic|password|api_?key|mgmt|authorization/i;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (SECRET_KEY.test(key)) out[key] = "[redacted]";
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else out[key] = value;
  }
  return out;
}

const defaultWrite = (line: string, level: LogLevel) => {
  if (level === "warn" || level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minRank = LEVEL_RANK[opts.minLevel ?? "info"];
  const write = opts.write ?? defaultWrite;
  const now = opts.now ?? (() => Date.now());
  const base = opts.base ?? {};

  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LEVEL_RANK[level] < minRank) return;
    const line = JSON.stringify({
      ts: new Date(now()).toISOString(),
      level,
      msg,
      ...redact({ ...base, ...fields }),
    });
    write(line, level);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

/** Logger that drops everything. Used by tests that do not inspect logs. */
export const silentLogger: Logger = createLogger({ write: () => undefined });
