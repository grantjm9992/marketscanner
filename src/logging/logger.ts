import pino from 'pino';

export type Logger = pino.Logger;

export interface LoggerOptions {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  readonly pretty?: boolean;
}

export function createLogger(opts: LoggerOptions): Logger {
  const transport = opts.pretty
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
      }
    : undefined;

  return pino({
    level: opts.level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // Defense in depth: even if a private key sneaks into a log payload,
      // pino redacts it before serialization.
      paths: [
        'privateKey',
        '*.privateKey',
        'polymarket.privateKey',
        'POLYMARKET_PRIVATE_KEY',
      ],
      censor: '[REDACTED]',
    },
    ...(transport ? { transport } : {}),
  });
}
