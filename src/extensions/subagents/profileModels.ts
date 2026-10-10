import { errorMessage } from '../../errors.js';
import { isRecord } from '../../isRecord.js';
import { parseModelReference } from '../../models/models.js';
import { readUserOnlyKey, warnUnknownKeys } from '../../tauConfig.js';
import type { ConfigLocation, ConfigWarnings } from '../../tauConfig.js';
import { anyKey } from '../../unknownKeys.js';
import type { KnownKeys } from '../../unknownKeys.js';
import type { ModelRoute, RouteLabel } from './modelRoutes.js';
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

const parseText = (source: string, field: string, value: unknown): string => {
  if (value === undefined) {
    throw invalid(source, `${field} is missing.`);
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(source, `${field} must be a non-empty string.`);
  }

  return value;
};

const parseCanary = (source: string, field: string, value: unknown): number => {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw invalid(source, `${field} must be a number from 0 to 1.`);
  }

  if (value < 0 || value > 1) {
    throw invalid(source, `${field} ${value} is outside the range 0 to 1.`);
  }

  return value;
};

const parseLabel = (source: string, field: string, entry: unknown): RouteLabel => {
  if (!isRecord(entry)) {
    throw invalid(
      source,
      `${field} must be an object such as {"criterion": "...", "model": "provider/model-id"}.`,
    );
  }

  return {
    criterion: parseText(source, `${field}.criterion`, entry.criterion),
    model: parseModel(source, `${field}.model`, entry.model),
  };
};

const parseRoute = (source: string, field: string, entry: unknown): ModelRoute => {
  if (!isRecord(entry)) {
    throw invalid(source, `${field} must be an object with question and labels.`);
  }

  const question = parseText(source, `${field}.question`, entry.question);

  const labelEntries = entry.labels;

  if (labelEntries === undefined) {
    throw invalid(source, `${field}.labels is missing.`);
  }

  if (!isRecord(labelEntries)) {
    throw invalid(source, `${field}.labels must be an object that maps label names to routes.`);
  }

  const names = Object.keys(labelEntries);

  if (names.length !== 2) {
    throw invalid(source, `${field}.labels must have exactly two labels, not ${names.length}.`);
  }

  if (names.some((name) => name.trim() === '')) {
    throw invalid(source, `${field}.labels must not have an empty label name.`);
  }

  const labels = new Map(
    names.map((name) => [name, parseLabel(source, `${field}.labels.${name}`, labelEntries[name])]),
  );

  const canary = parseCanary(source, `${field}.canary`, entry.canary);

  return { question, labels, canary };
};

const knownProfileKeys: KnownKeys = {
  model: true,
  routes: {
    question: true,
    canary: true,
    labels: { [anyKey]: { criterion: true, model: true } },
  },
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

// The model of one profile, or undefined when the profile has no entry.
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

// A bad route turns routing off for the profile and leaves its model usable.
export const readProfileRoute = (
  location: ConfigLocation,
  name: string,
  ui: ConfigWarnings,
): ModelRoute | undefined => {
  try {
    const record = readProfileRecord(location, name, ui);

    if (record === undefined || record.entry.routes === undefined) {
      return undefined;
    }

    return parseRoute(record.source, `${record.field}.routes`, record.entry.routes);
  } catch (error) {
    ui.notify(`${errorMessage(error)} Routing is off for ${name}.`, 'error');

    return undefined;
  }
};
