import { isRecord } from '../../isRecord.js';
import { parseModelReference } from '../../models/models.js';
import { readUserOnlyKey } from '../../tauConfig.js';
import type { ConfigLocation } from '../../tauConfig.js';
import type { ModelRoute, RouteLabel } from './modelRoutes.js';
import type { ProfileModels } from './workerModels.js';

export type ProfileRoutes = ReadonlyMap<string, ModelRoute>;

interface ProfileEntry {
  model: string;
  route: ModelRoute | undefined;
}

const invalid = (source: string, message: string): Error =>
  new Error(`Invalid Tau config ${source}: ${message}`);

const rejectUnknownKeys = (
  source: string,
  field: string,
  entry: Record<string, unknown>,
  known: readonly string[],
) => {
  const unknownKey = Object.keys(entry).find((key) => !known.includes(key));

  if (unknownKey !== undefined) {
    throw invalid(
      source,
      `${field}.${unknownKey} is not a known key. Set only ${known.join(', ')}.`,
    );
  }
};

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

  rejectUnknownKeys(source, field, entry, ['criterion', 'model']);

  return {
    criterion: parseText(source, `${field}.criterion`, entry.criterion),
    model: parseModel(source, `${field}.model`, entry.model),
  };
};

const parseRoute = (source: string, field: string, entry: unknown): ModelRoute => {
  if (!isRecord(entry)) {
    throw invalid(source, `${field} must be an object with question and labels.`);
  }

  rejectUnknownKeys(source, field, entry, ['question', 'labels', 'canary']);
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

const parseProfileEntry = (source: string, field: string, entry: unknown): ProfileEntry => {
  if (!isRecord(entry)) {
    throw invalid(source, `${field} must be an object such as {"model": "provider/model-id"}.`);
  }

  rejectUnknownKeys(source, field, entry, ['model', 'routes']);
  const model = parseModel(source, `${field}.model`, entry.model);

  if (entry.routes === undefined) {
    return { model, route: undefined };
  }

  return { model, route: parseRoute(source, `${field}.routes`, entry.routes) };
};

// Entries for profiles that do not exist are kept, since a profile may exist only in one repository.
const readProfileEntries = (location: ConfigLocation): Map<string, ProfileEntry> => {
  const user = readUserOnlyKey(location, 'profiles');

  if (user === undefined) {
    return new Map();
  }

  const { source, value: profiles } = user;

  if (!isRecord(profiles)) {
    throw invalid(
      source,
      'profiles must be an object that maps profile names to {"model": "provider/model-id"}.',
    );
  }

  return new Map(
    Object.entries(profiles).map(([name, entry]) => [
      name,
      parseProfileEntry(source, `profiles.${name}`, entry),
    ]),
  );
};

export const readProfileModels = (location: ConfigLocation): ProfileModels =>
  new Map([...readProfileEntries(location)].map(([name, { model }]) => [name, model]));

export const readProfileRoutes = (location: ConfigLocation): ProfileRoutes =>
  new Map(
    [...readProfileEntries(location)].flatMap(([name, { route }]) =>
      route === undefined ? [] : [[name, route] as const],
    ),
  );
