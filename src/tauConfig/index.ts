import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../errors/index.js';

export interface ConfigLocation {
  cwd: string;
  agentDirectory: string;
  projectTrusted: boolean;
}

// Each consumer validates its own top-level key in `value`.
export interface ConfigFile {
  source: string;
  value: unknown;
}

export interface TauConfigFiles {
  // The user file first, then the repository file.
  files: ConfigFile[];
  // A repository config file that was skipped because the project is not trusted.
  ignored: string | undefined;
}

export const configFileName = 'tau.json';

export const userConfigPath = (agentDirectory: string): string =>
  join(agentDirectory, configFileName);

const readConfigFile = (source: string): ConfigFile | undefined => {
  let text: string;

  try {
    text = readFileSync(source, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw new Error(`Could not read Tau config ${source}: ${String(error)}`, { cause: error });
  }

  try {
    return { source, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`Invalid Tau config ${source}: not valid JSON (${String(error)})`, {
      cause: error,
    });
  }
};

// Pi's project trust gates the repository file, as it gates `.pi/settings.json`.
export const readTauConfig = ({
  cwd,
  agentDirectory,
  projectTrusted,
}: ConfigLocation): TauConfigFiles => {
  const projectPath = join(cwd, CONFIG_DIR_NAME, configFileName);
  const user = readConfigFile(userConfigPath(agentDirectory));
  const project = projectTrusted ? readConfigFile(projectPath) : undefined;
  const ignored = !projectTrusted && existsSync(projectPath) ? projectPath : undefined;

  return { files: [user, project].filter((file) => file !== undefined), ignored };
};
