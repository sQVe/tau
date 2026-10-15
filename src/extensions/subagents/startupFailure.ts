import { Value } from 'typebox/value';

import { errorMessage } from '../../errors.js';
import { isRecord } from '../../isRecord.js';
import { publishRecord, readOptionalRecord, TaskFormatError } from './records.js';
import type { StartupEvidence } from './startupFailureDecision.js';
import { taskFormat } from './taskFormat.js';
import { startupFailureSchema } from './types.js';
import type { StartupFailure } from './types.js';

const messageLimit = 2000;
const startupFailureVersion = 1;

const failureKind = (error: unknown): StartupFailure['kind'] => {
  const cause = error instanceof Error ? error.cause : undefined;

  if (cause instanceof TaskFormatError) {
    return cause.format === 'retired' ? 'taskRetired' : 'taskNewer';
  }

  return 'failed';
};

const failureMessage = (error: unknown): string => {
  const message = errorMessage(error);

  if (message !== '') {
    return message;
  }

  return error instanceof Error && error.name !== '' ? error.name : 'Unknown startup error';
};

// The task may be unreadable, so this record has no task id. The first failure stays.
export const recordStartupFailure = (directory: string, error: unknown): void => {
  const failure: StartupFailure = {
    version: 1,
    kind: failureKind(error),
    message: failureMessage(error).slice(0, messageLimit),
  };

  try {
    publishRecord(directory, 'startupError.json', failure);
  } catch {
    // The worker is shutting down anyway; a missing record only hides the cause from the manager.
  }
};

// Never throws: the manager keeps its own error whatever the record holds.
export const readStartupFailure = (directory: string): StartupEvidence => {
  try {
    const value = readOptionalRecord(directory, 'startupError.json');

    if (value === undefined) {
      return { status: 'missing' };
    }

    const savedVersion = isRecord(value) ? value.version : undefined;

    if (taskFormat(savedVersion, startupFailureVersion, startupFailureVersion) === 'newer') {
      return { status: 'newer' };
    }

    if (Value.Check(startupFailureSchema, value)) {
      return { status: 'current', failure: value };
    }

    return { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
};
