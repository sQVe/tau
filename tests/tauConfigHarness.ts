import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigLocation } from '../src/config/config.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface TemporaryTauConfig {
  location: ConfigLocation;
  userFile: string;
  repositoryFile: string;
  writeUser: (value: unknown) => void;
  writeRepository: (value: unknown) => void;
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
