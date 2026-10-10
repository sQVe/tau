import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from './errors.js';
import { isRecord } from './isRecord.js';
import { findUnknownKeys, reportedId, unreportedKeys } from './unknownKeys.js';
import type { KnownKeys } from './unknownKeys.js';

export type ConfigWarnings = Pick<ExtensionUIContext, 'notify'>;

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

const setsKey = ({ value }: ConfigFile, key: string): boolean =>
  isRecord(value) && Object.hasOwn(value, key);

// The user owns which models they pay for and trust, so a repository file cannot set a model key.
export const readUserOnlyKey = (location: ConfigLocation, key: string): ConfigFile | undefined => {
  const { files } = readTauConfig(location);
  const userPath = userConfigPath(location.agentDirectory);
  const repository = files.find((file) => file.source !== userPath && setsKey(file, key));

  if (repository !== undefined) {
    throw new Error(
      `Invalid Tau config ${repository.source}: ${key} may be set only in the user file ${userPath}. Remove ${key} from ${repository.source}.`,
    );
  }

  const user = files.find((file) => file.source === userPath)?.value;

  if (!isRecord(user) || !Object.hasOwn(user, key)) {
    return undefined;
  }

  return { source: userPath, value: user[key] };
};

const reportedBySession = new WeakMap<object, Set<string>>();

const reportedFor = (ui: ConfigWarnings): Set<string> => {
  const reported = reportedBySession.get(ui) ?? new Set<string>();

  reportedBySession.set(ui, reported);

  return reported;
};

// Forgets what was reported for `ui`, so a new session reports its config problems again.
export const forgetReportedWarnings = (ui: ConfigWarnings): void => {
  reportedBySession.delete(ui);
};

// Notifies once per session for each file and `key`. A changed message under the same key is not
// reported again, so put what makes a problem new into the key.
export const notifyOnce = (
  ui: ConfigWarnings,
  source: string,
  key: string,
  message: string,
  level: 'warning' | 'error',
): void => {
  const reported = reportedFor(ui);
  const [fresh] = unreportedKeys(reported, source, [key]);

  if (fresh === undefined) {
    return;
  }

  reported.add(reportedId(source, fresh));
  ui.notify(message, level);
};

// Warns once per session for each file and unknown key path in `value`. `known` lists the keys the
// reader understands and `path` names where `value` sits in the file, such as `profiles.worker`.
export const warnUnknownKeys = (
  ui: ConfigWarnings,
  source: string,
  value: unknown,
  known: KnownKeys,
  path: string,
): void => {
  const reported = reportedFor(ui);
  const fresh = unreportedKeys(reported, source, findUnknownKeys(value, known, path));

  for (const keyPath of fresh) {
    reported.add(reportedId(source, keyPath));
    ui.notify(`Tau config ${source}: ${keyPath} is not a known key and was ignored.`, 'warning');
  }
};
