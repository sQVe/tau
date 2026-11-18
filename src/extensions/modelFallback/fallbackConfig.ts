import { readUserOnlyKey } from '../../config/config.js';
import type { ConfigFile, ConfigLocation } from '../../config/config.js';
import { parseModelReference } from '../../config/models.js';
import { errorMessage } from '../../errors.js';
import { findUnknownKeys, isRecord } from '../../schema.js';
import type { KnownKeys } from '../../schema.js';

export interface FallbackModel {
  name: string;
  primary: string;
  fallback: string;
  fallbackAtRetry: number;
}

export interface FallbackModelsRead {
  models: FallbackModel[];
  problems: string[];
  warnings: string[];
}

type EntryRead = { kind: 'model'; model: FallbackModel } | { kind: 'invalid'; problem: string };

export const virtualModelProvider = 'tau';

const namePattern = /^[a-z0-9][a-z0-9-]*$/u;

const knownEntryKeys: KnownKeys = { primary: true, fallback: true, fallbackAtRetry: true };

const invalid = (source: string, message: string): string =>
  `Invalid Tau config ${source}: ${message}`;

const invalidEntry = (source: string, message: string): EntryRead => ({
  kind: 'invalid',
  problem: invalid(source, message),
});

const isModelReference = (value: unknown): value is string =>
  typeof value === 'string' && parseModelReference(value) !== undefined;

const isVirtualModel = (reference: string): boolean =>
  parseModelReference(reference)?.provider === virtualModelProvider;

const isRetryCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const readEntry = (source: string, name: string, value: unknown): EntryRead => {
  if (!namePattern.test(name)) {
    return invalidEntry(
      source,
      `fallbackModels.${name} must use lower-case letters, digits, and hyphens.`,
    );
  }

  if (!isRecord(value)) {
    return invalidEntry(source, `fallbackModels.${name} must be an object.`);
  }

  const field = `fallbackModels.${name}`;
  const { primary, fallback, fallbackAtRetry } = value;

  if (!isModelReference(primary)) {
    return invalidEntry(
      source,
      `${field}.primary ${JSON.stringify(primary)} is not provider/model-id.`,
    );
  }

  if (isVirtualModel(primary)) {
    return invalidEntry(
      source,
      `${field}.primary ${JSON.stringify(primary)} names a Tau virtual model; use a physical model.`,
    );
  }

  if (!isModelReference(fallback)) {
    return invalidEntry(
      source,
      `${field}.fallback ${JSON.stringify(fallback)} is not provider/model-id.`,
    );
  }

  if (isVirtualModel(fallback)) {
    return invalidEntry(
      source,
      `${field}.fallback ${JSON.stringify(fallback)} names a Tau virtual model; use a physical model.`,
    );
  }

  if (primary === fallback) {
    return invalidEntry(source, `${field} names the same model as primary and fallback.`);
  }

  if (!isRetryCount(fallbackAtRetry)) {
    return invalidEntry(
      source,
      `${field}.fallbackAtRetry ${JSON.stringify(fallbackAtRetry)} must be a whole number of at least 1.`,
    );
  }

  return { kind: 'model', model: { name, primary, fallback, fallbackAtRetry } };
};

const unknownKeyWarnings = (source: string, name: string, value: unknown): string[] =>
  isRecord(value)
    ? findUnknownKeys(value, knownEntryKeys, '').map((key) =>
        invalid(source, `fallbackModels.${name} has unknown key ${key}.`),
      )
    : [];

export const readFallbackModels = (location: ConfigLocation): FallbackModelsRead => {
  let user: ConfigFile | undefined;

  try {
    user = readUserOnlyKey(location, 'fallbackModels');
  } catch (error) {
    return { models: [], problems: [errorMessage(error)], warnings: [] };
  }

  if (user === undefined) {
    return { models: [], problems: [], warnings: [] };
  }

  const { source, value } = user;

  if (!isRecord(value)) {
    return {
      models: [],
      problems: [
        invalid(
          source,
          'fallbackModels must be an object that maps names to {"primary", "fallback", "fallbackAtRetry"}.',
        ),
      ],
      warnings: [],
    };
  }

  const models: FallbackModel[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const [name, entry] of Object.entries(value)) {
    const read = readEntry(source, name, entry);

    warnings.push(...unknownKeyWarnings(source, name, entry));

    if (read.kind === 'invalid') {
      problems.push(read.problem);

      continue;
    }

    models.push(read.model);
  }

  return { models, problems, warnings };
};
