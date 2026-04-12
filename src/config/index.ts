import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultConfig, normalizeConfig, parseConfigFile } from './schema.js';
import { ConfigValidationError } from './types.js';
import type { Config } from './types.js';

export type { Config } from './types.js';
export { ConfigValidationError } from './types.js';

const configPath = (rootDir: string) => join(rootDir, 'tau.config.json');

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  isNodeError(error) && error.code === 'ENOENT';

const cloneConfig = (config: Config) => structuredClone(config);

const loadDefaultConfig = (rootDir: string) => normalizeConfig(rootDir, defaultConfig);

export const loadConfig = async (rootDir = process.cwd()): Promise<Config> => {
  let raw: string;

  try {
    raw = await readFile(configPath(rootDir), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return cloneConfig(loadDefaultConfig(rootDir));
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError('<root>', `invalid JSON: ${message}`);
  }

  const config = normalizeConfig(rootDir, parseConfigFile(parsed));
  return cloneConfig(config);
};
