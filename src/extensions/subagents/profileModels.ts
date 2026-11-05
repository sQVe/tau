import { Value } from 'typebox/value';

import {
  notifyOnce,
  readUserOnlyKey,
  userConfigPath,
  warnUnknownKeys,
} from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { parseModelReference } from '../../config/models.js';
import { errorMessage } from '../../errors.js';
import { anyKey, isRecord } from '../../schema.js';
import type { KnownKeys } from '../../schema.js';
import { defaultRouteConfidence } from './modelRoutes.js';
import type { ModelRoute, RouteLabel } from './modelRoutes.js';
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

const parseText = (source: string, field: string, value: unknown): string => {
  if (value === undefined) {
    throw invalid(source, `${field} is missing.`);
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(source, `${field} must be a non-empty string.`);
  }

  return value;
};

const parseRatio = (source: string, field: string, value: unknown, missing: number): number => {
  if (value === undefined) {
    return missing;
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw invalid(source, `${field} must be a number from 0 to 1.`);
  }

  if (value < 0 || value > 1) {
    throw invalid(source, `${field} ${value} is outside the range 0 to 1.`);
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

const parseLabel = (source: string, field: string, entry: unknown): RouteLabel => {
  if (!isRecord(entry)) {
    throw invalid(
      source,
      `${field} must be an object such as {"criterion": "...", "model": "provider/model-id"}.`,
    );
  }

  const thinking = parseThinking(source, `${field}.thinking`, entry.thinking);

  return {
    criterion: parseText(source, `${field}.criterion`, entry.criterion),
    model: parseModel(source, `${field}.model`, entry.model),
    ...(thinking === undefined ? {} : { thinking }),
  };
};

const parseRoute = (source: string, field: string, entry: unknown): ModelRoute => {
  if (!isRecord(entry)) {
    throw invalid(source, `${field} must be an object with classifier, question, and labels.`);
  }

  const classifier = parseModel(source, `${field}.classifier`, entry.classifier);
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

  const confidence = parseRatio(
    source,
    `${field}.confidence`,
    entry.confidence,
    defaultRouteConfidence,
  );

  return { classifier, question, labels, confidence };
};

const knownProfileKeys: KnownKeys = {
  model: true,
  thinking: true,
  routes: true,
  route: {
    classifier: true,
    question: true,
    confidence: true,
    labels: { [anyKey]: { criterion: true, model: true, thinking: true } },
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

// A bad route turns routing off for the profile and leaves its model usable.
export const readProfileRoute = (
  location: ConfigLocation,
  name: string,
  ui: ConfigWarnings,
): ModelRoute | undefined => {
  try {
    const record = readProfileRecord(location, name, ui);

    if (record === undefined) {
      return undefined;
    }

    if (record.entry.routes !== undefined) {
      throw invalid(
        record.source,
        `${record.field}.routes is no longer read. Rename it to ${record.field}.route and add ${record.field}.route.classifier as provider/model-id.`,
      );
    }

    if (record.entry.route === undefined) {
      return undefined;
    }

    return parseRoute(record.source, `${record.field}.route`, record.entry.route);
  } catch (error) {
    const message = `${errorMessage(error)} Routing is off for ${name}.`;

    notifyOnce(ui, userConfigPath(location.agentDirectory), message, message, 'error');

    return undefined;
  }
};
