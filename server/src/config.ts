// server/src/config.ts
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  uiDir: string;
}

export function loadConfig(): Config {
  const dataDir = process.env.FIRESIDE_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  return {
    port: Number(process.env.FIRESIDE_PORT ?? '8787'),
    host: process.env.FIRESIDE_HOST ?? '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'fireside.sqlite'),
    uiDir: path.resolve(process.cwd(), 'ui'),
  };
}
