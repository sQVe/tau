import { findUnknownKeys, isRecord } from '../schema.js';
import type { KnownKeys } from '../schema.js';
import { readUserOnlyKey } from './config.js';
import type { ConfigFile, ConfigLocation } from './config.js';
import { parseModelReference } from './models.js';

interface FallbackModel {
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

type EntryRead =
  | { kind: 'model'; model: FallbackModel; warnings: string[] }
  | { kind: 'invalid'; problem: string };

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

  if (!isModelReference(fallback)) {
    return invalidEntry(
      source,
      `${field}.fallback ${JSON.stringify(fallback)} is not provider/model-id.`,
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

  const warnings = findUnknownKeys(value, knownEntryKeys, '').map((key) =>
    invalid(source, `${field} has unknown key ${key}.`),
  );

  return { kind: 'model', model: { name, primary, fallback, fallbackAtRetry }, warnings };
};

const problemMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const readFallbackModels = (location: ConfigLocation): FallbackModelsRead => {
  let user: ConfigFile | undefined;

  try {
    user = readUserOnlyKey(location, 'fallbackModels');
  } catch (error) {
    return { models: [], problems: [problemMessage(error)], warnings: [] };
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

  const reads = Object.entries(value).map(([name, entry]) => readEntry(source, name, entry));
  const models = reads.flatMap((read) => (read.kind === 'model' ? [read.model] : []));
  const problems = reads.flatMap((read) => (read.kind === 'invalid' ? [read.problem] : []));
  const warnings = reads.flatMap((read) => (read.kind === 'model' ? read.warnings : []));

  return { models, problems, warnings };
};
