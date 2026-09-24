import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { readRecord } from './records.js';

// Activity snapshots adapt pi-interactive-subagents c3e8b53 (MIT; see LICENSE).
const activitySchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    sequence: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Number({ minimum: 0 }),
    phase: Type.Union([
      Type.Literal('starting'),
      Type.Literal('active'),
      Type.Literal('waiting'),
      Type.Literal('done'),
    ]),
    label: Type.Optional(Type.String({ maxLength: 200, pattern: '^[^\\r\\n]*$' })),
    description: Type.Optional(Type.String({ maxLength: 200, pattern: '^[^\\r\\n]*$' })),
    descriptionAt: Type.Optional(Type.Number({ minimum: 0 })),
    model: Type.Optional(Type.String({ maxLength: 200, pattern: '^[^\\r\\n]*$' })),
    usage: Type.Optional(
      Type.Object(
        {
          input: Type.Number({ minimum: 0 }),
          output: Type.Number({ minimum: 0 }),
          cacheRead: Type.Number({ minimum: 0 }),
          cacheWrite: Type.Number({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type WorkerActivity = Static<typeof activitySchema>;

export const phaseDescriptionLimit = 200;

// A worker-authored phase is plain single-line text. Reject empty, control-character, or oversized
// input at the trust boundary before any activity is written.
export const parsePhaseDescription = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error('Progress description must not be empty.');
  }

  if (trimmed.length > phaseDescriptionLimit) {
    throw new Error(`Progress description must be at most ${phaseDescriptionLimit} characters.`);
  }

  if (/\p{Cc}/u.test(trimmed)) {
    throw new Error('Progress description must be one line without control characters.');
  }

  return trimmed;
};

const activityFile = (directory: string): string => join(directory, 'activity.json');

export const writeWorkerActivity = (directory: string, activity: WorkerActivity): void => {
  const path = activityFile(directory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);

  try {
    writeFileSync(descriptor, `${JSON.stringify(activity)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }

  closeSync(descriptor);

  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
};

export const readWorkerActivity = (
  directory: string,
  taskId: string,
): WorkerActivity | undefined => {
  try {
    const value = readRecord(directory, 'activity.json');

    if (!Value.Check(activitySchema, value) || value.taskId !== taskId) {
      return undefined;
    }

    return value;
  } catch {
    return undefined;
  }
};
