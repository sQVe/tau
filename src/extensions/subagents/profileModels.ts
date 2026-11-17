import { Value } from 'typebox/value';

import { readUserOnlyKey, warnUnknownKeys } from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { parseModelReference } from '../../config/models.js';
import { isRecord } from '../../schema.js';
import type { KnownKeys } from '../../schema.js';
import { thinkingSchema } from './types.js';
import type { ThinkingLevel } from './types.js';
import type { ProfileModels } from './workerModels.js';

interface ProfileEntries {
  source: string;
  entries: Record<string, unknown>;
}

interface ProfileRecord {
  source: string;
  field: string;
  entry: Record<string, unknown>;
}

const invalid = (source: string, message: string): Error =>
  new Error(`Invalid Tau config ${source}: ${message}`);

const parseModel = (source: string, field: string, value: unknown): string => {
  if (value === undefined) {
    throw invalid(source, `${field} is missing.`);
  }

  if (typeof value !== 'string' || !parseModelReference(value)) {
    throw invalid(source, `${field} ${JSON.stringify(value)} is not provider/model-id.`);
  }

  return value;
};

const parseThinking = (
  source: string,
  field: string,
  value: unknown,
): ThinkingLevel | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Value.Check(thinkingSchema, value)) {
    throw invalid(source, `${field} ${JSON.stringify(value)} is not a thinking level.`);
  }

  return value;
};

const knownProfileKeys: KnownKeys = {
  model: true,
  thinking: true,
};

// Entries for profiles that do not exist are kept, since a profile may exist only in one repository.
const readProfileEntries = (location: ConfigLocation): ProfileEntries | undefined => {
  const user = readUserOnlyKey(location, 'profiles');

  if (user === undefined) {
    return undefined;
  }

  const { source, value } = user;

  if (!isRecord(value)) {
    throw invalid(
      source,
      'profiles must be an object that maps profile names to {"model": "provider/model-id"}.',
    );
  }

  return { source, entries: value };
};

// Reads one entry and warns about its unknown keys. Only a bad entry of this name fails.
const readProfileRecord = (
  location: ConfigLocation,
  name: string,
  ui: ConfigWarnings,
): ProfileRecord | undefined => {
  const profiles = readProfileEntries(location);

  if (profiles === undefined || !Object.hasOwn(profiles.entries, name)) {
    return undefined;
  }

  const { source, entries } = profiles;
  const field = `profiles.${name}`;
  const entry = entries[name];

  if (!isRecord(entry)) {
    throw invalid(source, `${field} must be an object such as {"model": "provider/model-id"}.`);
  }

  warnUnknownKeys(ui, source, entry, knownProfileKeys, field);

  return { source, field, entry };
};

export const readProfileModel = (
  location: ConfigLocation,
  name: string,
  ui: ConfigWarnings,
): string | undefined => {
  const record = readProfileRecord(location, name, ui);

  if (record === undefined) {
    return undefined;
  }

  return parseModel(record.source, `${record.field}.model`, record.entry.model);
};

export const readProfileThinking = (
  location: ConfigLocation,
  name: string,
  ui: ConfigWarnings,
): ThinkingLevel | undefined => {
  const record = readProfileRecord(location, name, ui);

  if (record === undefined) {
    return undefined;
  }

  return parseThinking(record.source, `${record.field}.thinking`, record.entry.thinking);
};

// A bad entry is left out here and fails only the launch of that profile.
export const readProfileModels = (location: ConfigLocation, ui: ConfigWarnings): ProfileModels => {
  const names = Object.keys(readProfileEntries(location)?.entries ?? {});
  const models = new Map<string, string>();

  for (const name of names) {
    try {
      const model = readProfileModel(location, name, ui);

      if (model !== undefined) {
        models.set(name, model);
      }
    } catch {
      continue;
    }
  }

  return models;
};
