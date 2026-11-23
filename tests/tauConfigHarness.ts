import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import type { ConfigLocation } from '../src/config/config.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface TemporaryTauConfig {
  location: ConfigLocation;
  userFile: string;
  repositoryFile: string;
  writeUser: (value: unknown) => void;
  writeRepository: (value: unknown) => void;
}

interface ConfigBytes {
  user: string;
  repository: string | undefined;
}

export interface TauConfigSnapshot {
  expectUnchanged: () => void;
}

export const temporaryTauConfig = (
  onTestFinished: (cleanup: () => void) => void,
  prefix: string,
): TemporaryTauConfig => {
  const directory = temporaryDirectory(onTestFinished, prefix);
  const agentDirectory = join(directory, 'agent');
  const userFile = join(agentDirectory, 'tau.json');
  const repositoryFile = join(directory, '.pi', 'tau.json');

  mkdirSync(agentDirectory);
  mkdirSync(join(directory, '.pi'));

  const location: ConfigLocation = { cwd: directory, agentDirectory, projectTrusted: true };

  return {
    location,
    userFile,
    repositoryFile,
    writeUser: (value: unknown) => {
      writeFileSync(userFile, JSON.stringify(value));
    },
    writeRepository: (value: unknown) => {
      writeFileSync(repositoryFile, JSON.stringify(value));
    },
  };
};

const readConfigBytes = (userFile: string, repositoryFile: string): ConfigBytes => ({
  user: readFileSync(userFile, 'utf8'),
  repository: existsSync(repositoryFile) ? readFileSync(repositoryFile, 'utf8') : undefined,
});

export const tauConfigSnapshot = (userFile: string, repositoryFile: string): TauConfigSnapshot => {
  const before = readConfigBytes(userFile, repositoryFile);

  return {
    expectUnchanged: () => {
      const after = readConfigBytes(userFile, repositoryFile);

      expect(after.user).toBe(before.user);
      expect(after.repository).toBe(before.repository);
    },
  };
};
