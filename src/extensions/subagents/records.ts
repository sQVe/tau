import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { Value } from 'typebox/value';

import { eventSchema, reportSchema, taskSchema } from './types.js';
import type { Report, Task, TaskEvent } from './types.js';

const recordByteLimit = 128_000;

// Publish complete files without replacing an accepted record. This is not protection from trusted workers editing files directly.
export const publish = (directory: string, name: string, value: unknown): void => {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > recordByteLimit) {
    throw new Error('Worker record exceeds 128 KB.');
  }

  const temporary = join(directory, `.receipt-${randomUUID()}`);
  const descriptor = openSync(temporary, 'wx', 0o600);

  try {
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  try {
    linkSync(temporary, join(directory, name));
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    unlinkSync(temporary);
  }
};

export const readRecord = (directory: string, name: string): unknown => {
  const descriptor = openSync(join(directory, name), 'r');
  try {
    const buffer = Buffer.alloc(recordByteLimit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = readSync(descriptor, buffer, {
        offset: bytesRead,
        length: buffer.length - bytesRead,
        position: bytesRead,
      });
      if (read === 0) {
        break;
      }
      bytesRead += read;
    }

    if (bytesRead > recordByteLimit) {
      throw new Error('Worker record exceeds 128 KB.');
    }

    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    closeSync(descriptor);
  }
};

export const validateTask = (value: unknown): Task => {
  if (!Value.Check(taskSchema, value)) {
    throw new Error('Invalid saved worker task or loadout.');
  }
  if (
    value.deadline <= value.createdAt + value.cancellationBudget ||
    value.deadline - value.createdAt > 2_147_483_647
  ) {
    throw new Error('Invalid fixed worker deadline.');
  }
  if (
    ![
      value.nativeSessionFile,
      value.parentSession,
      value.loadout.cwd,
      value.loadout.agentDirectory,
      value.loadout.safetyExtension,
      ...value.loadout.integrations,
    ].every(isAbsolute)
  ) {
    throw new Error('Worker paths must be absolute.');
  }
  if (
    value.taskId === value.nativeSessionId ||
    !value.loadout.integrations.includes(value.loadout.safetyExtension)
  ) {
    throw new Error('Invalid worker identity or missing safety integration.');
  }
  if (
    !['read', 'bash', 'edit', 'write', 'subagent_report'].every((tool) =>
      value.loadout.tools.includes(tool),
    )
  ) {
    throw new Error('A trusted worker requires the coding and report tools.');
  }

  return value;
};

export const readTask = (directory: string): Task => {
  return validateTask(readRecord(directory, 'task.json'));
};

const validReport = (value: unknown, taskId: string): value is Report =>
  Value.Check(reportSchema, value) &&
  value.taskId === taskId &&
  Buffer.byteLength(JSON.stringify(value)) <= 64_000;

export const acceptReport = (directory: string, taskId: string, value: unknown): Report => {
  if (!validReport(value, taskId)) {
    throw new Error('Invalid, oversized, or wrong-task report.');
  }

  publish(directory, 'report.json', value);

  return value;
};

export const readReport = (directory: string, taskId: string): Report | undefined => {
  try {
    const value = readRecord(directory, 'report.json');
    if (!validReport(value, taskId)) {
      throw new Error('Invalid saved worker report.');
    }

    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const recordEvent = (
  directory: string,
  taskId: string,
  kind: TaskEvent['kind'],
  detail: string,
  stopped = false,
  processId?: number,
): void => {
  publish(directory, `${kind}.json`, {
    taskId,
    kind,
    detail,
    stopped,
    at: Date.now(),
    ...(processId === undefined ? {} : { processId }),
  });
};

export const readEvent = (
  directory: string,
  taskId: string,
  kind: TaskEvent['kind'],
): TaskEvent | undefined => {
  try {
    const value = readRecord(directory, `${kind}.json`);
    if (!Value.Check(eventSchema, value) || value.taskId !== taskId || value.kind !== kind) {
      throw new Error('Invalid worker lifecycle record.');
    }

    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};
