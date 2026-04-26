// server/src/logger.ts
import pino, { type LoggerOptions } from 'pino';

const defaultLevel =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

const options: LoggerOptions = {
  level: defaultLevel,
  ...(process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }),
};

export const logger = pino(options);
