import { parseModelReference } from '../../delegateModel/index.js';
import { readTauConfig, userConfigPath } from '../../tauConfig/index.js';
import type { ConfigFile, ConfigLocation } from '../../tauConfig/index.js';
import type { ProfileModels } from './workerModels.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const profileModel = (source: string, name: string, entry: unknown): string => {
  const field = `profiles.${name}`;

  if (!isRecord(entry)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"model": "provider/model-id"}.`,
    );
  }

  const unknownKey = Object.keys(entry).find((key) => key !== 'model');

  if (unknownKey !== undefined) {
    throw new Error(
      `Invalid Tau config ${source}: ${field}.${unknownKey} is not a known key. Set only model.`,
    );
  }

  if (entry.model === undefined) {
    throw new Error(`Invalid Tau config ${source}: ${field}.model is missing.`);
  }

  if (typeof entry.model !== 'string' || !parseModelReference(entry.model)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field}.model ${JSON.stringify(entry.model)} is not provider/model-id.`,
    );
  }

  return entry.model;
};

const userProfileModels = ({ source, value }: ConfigFile): ProfileModels => {
  const profiles = isRecord(value) ? value.profiles : undefined;

  if (profiles === undefined) {
    return new Map();
  }

  if (!isRecord(profiles)) {
    throw new Error(
      `Invalid Tau config ${source}: profiles must be an object that maps profile names to {"model": "provider/model-id"}.`,
    );
  }

  return new Map(
    Object.entries(profiles).map(([name, entry]) => [name, profileModel(source, name, entry)]),
  );
};

// The user owns which models they pay for and trust, so a repository cannot choose one.
const requireNoProfiles = ({ source, value }: ConfigFile, userPath: string): void => {
  if (isRecord(value) && Object.hasOwn(value, 'profiles')) {
    throw new Error(
      `Invalid Tau config ${source}: profiles may be set only in the user file ${userPath}. Remove profiles from ${source}.`,
    );
  }
};

// Entries for profiles that do not exist are kept, since a profile may exist only in one repository.
export const readProfileModels = (location: ConfigLocation): ProfileModels => {
  const { files } = readTauConfig(location);
  const userPath = userConfigPath(location.agentDirectory);
  const user = files.find((file) => file.source === userPath);

  for (const file of files) {
    if (file !== user) {
      requireNoProfiles(file, userPath);
    }
  }

  return user === undefined ? new Map() : userProfileModels(user);
};
