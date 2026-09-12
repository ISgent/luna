import pino, { type Logger } from 'pino';

/**
 * Секреты не должны попадать в логи ни при каких обстоятельствах.
 * pino redact глушит их по путям в объектах логов.
 */
const REDACT_PATHS = [
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.DISCORD_TOKEN',
  '*.LLM_API_KEY',
  '*.TTS_API_KEY',
  '*.STT_API_KEY',
  '*.EMBEDDING_API_KEY',
  'req.headers.authorization',
  'headers.authorization',
];

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const transport = opts.pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      }
    : undefined;

  return pino({
    level: opts.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '***' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport,
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

export type { Logger };
