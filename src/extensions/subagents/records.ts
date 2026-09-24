import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, isMissingFile } from '../../errors/index.js';
import {
  eventSchema,
  reportSchema,
  taskSchema,
  successorSchema,
  isGenericLoadout,
  taskEndedEventKinds,
} from './types.js';
import type { GenericLoadout, Report, Successor, Task, TaskEvent } from './types.js';

const recordByteLimit = 128_000;

// Each Tau checkout keeps its own records, so a branch that changes the record format never
// breaks another checkout. This module sits three directories below the package root.
const checkoutRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const checkoutFolder = `${basename(checkoutRoot)}-${createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 8)}`;

export const workerRecordsDirectory = (): string =>
  join(getAgentDir(), 'tau', checkoutFolder, 'workers');

const serializeRecord = (value: unknown): string => {
  const serialized = `${JSON.stringify(value)}\n`;

  if (Buffer.byteLength(serialized, 'utf8') > recordByteLimit) {
    throw new Error('Worker record exceeds 128 KB.');
  }

  return serialized;
};

// Publish complete files without replacing an accepted record. This is not protection from trusted workers editing files directly.
export const publish = (directory: string, name: string, value: unknown): void => {
  const serialized = serializeRecord(value);
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

export const readOptionalRecord = (directory: string, name: string): unknown => {
  try {
    return readRecord(directory, name);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const nameMatchesRole = (task: Task): boolean =>
  task.name === undefined ||
  task.name.startsWith(task.loadout.role === 'editing' ? 'worker-' : 'investigator-');

const modelArgumentsAreConsistent = (loadout: GenericLoadout): boolean =>
  loadout.requestedModel === undefined || Boolean(loadout.arguments.length);

const genericOptionsAreConsistent = (task: Task, loadout: GenericLoadout): boolean =>
  nameMatchesRole(task) && modelArgumentsAreConsistent(loadout);

const hasAbsoluteGenericPaths = (task: Task, loadout: GenericLoadout): boolean =>
  [task.parentSession, loadout.cwd].every(isAbsolute);

const hasGenericTaskIdentity = (task: Task, loadout: GenericLoadout): boolean =>
  task.version === 2 &&
  task.predecessorTaskId === undefined &&
  !['pi', 'generic'].includes(loadout.kind);

const validateGenericTask = (task: Task, loadout: GenericLoadout): void => {
  const identityIsValid =
    hasGenericTaskIdentity(task, loadout) && hasAbsoluteGenericPaths(task, loadout);

  if (!identityIsValid || !genericOptionsAreConsistent(task, loadout)) {
    throw new Error('Invalid generic worker identity or native configuration.');
  }
};

const identityIsSelfConsistent = (task: Task): boolean =>
  task.predecessorTaskId !== task.taskId && task.taskId !== task.nativeSessionId;

export const validateTask = (value: unknown): Task => {
  if (!Value.Check(taskSchema, value)) {
    throw new Error('Invalid saved worker task or loadout.');
  }

  serializeRecord(value);

  if (
    value.deadline <= value.createdAt + value.cancellationBudget ||
    value.deadline - value.createdAt > 2_147_483_647
  ) {
    throw new Error('Invalid fixed worker deadline.');
  }

  if (isGenericLoadout(value.loadout)) {
    validateGenericTask(value, value.loadout);

    return value;
  }

  if (value.version !== 1) {
    throw new Error('Native worker session identity is required.');
  }

  if (
    ![
      value.nativeSessionFile,
      value.parentSession,
      value.loadout.cwd,
      value.loadout.agentDirectory,
    ].every(isAbsolute)
  ) {
    throw new Error('Worker paths must be absolute.');
  }

  if (!nameMatchesRole(value) || !identityIsSelfConsistent(value)) {
    throw new Error('Invalid worker identity.');
  }

  return value;
};

// Callers treat a missing task as unpublished, so only other failures name the task.
export const readTask = (directory: string): Task => {
  try {
    return validateTask(readRecord(directory, 'task.json'));
  } catch (error) {
    if (isMissingFile(error)) {
      throw error;
    }

    throw new Error(`Saved task ${basename(directory)} is unreadable: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};

const claimSessionMatchesTask = (claim: Successor, task: Task): boolean =>
  claim.successorTaskId !== task.taskId &&
  claim.nativeSessionId === task.nativeSessionId &&
  claim.nativeSessionFile === task.nativeSessionFile;

const claimMatchesTask = (claim: Successor, task: Task): boolean =>
  claim.predecessorTaskId === task.taskId && claimSessionMatchesTask(claim, task);

export const readSuccessor = (directory: string): Successor | undefined => {
  let value: unknown;

  try {
    value = readRecord(directory, 'successor.json');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }

  const task = readTask(directory);

  if (!Value.Check(successorSchema, value) || !claimMatchesTask(value, task)) {
    throw new Error('Invalid saved successor claim.');
  }

  return value;
};

const isUnpublishedDirectory = (directory: string): boolean =>
  readdirSync(directory, { withFileTypes: true }).every(
    (entry) => entry.isFile() && /^\.receipt-[a-f0-9-]+$/.test(entry.name),
  );

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Earlier Pi formats lacked a task-level monotonic deadline or saved replay fingerprints.
const isRetiredPiTask = (
  value: Record<string, unknown>,
  loadout: Record<string, unknown>,
): boolean => !('monotonicDeadline' in value) || 'modelFingerprint' in loadout;

const isRetiredHarness = (
  harness: unknown,
  value: Record<string, unknown>,
  loadout: Record<string, unknown>,
): boolean => {
  if (harness === undefined || harness === 'claude') {
    return true;
  }

  if (harness !== 'pi') {
    return false;
  }

  return isRetiredPiTask(value, loadout);
};

// Records from before the current saved format are never read, but they must not block unrelated tasks.
export const isRetiredTask = (value: unknown): boolean => {
  if (!isObjectRecord(value) || !('loadout' in value)) {
    return false;
  }

  if ('tree' in value || 'parentTaskId' in value) {
    return true;
  }

  const loadout = value.loadout;

  if (!isObjectRecord(loadout)) {
    return false;
  }

  const harness = 'harness' in loadout ? loadout.harness : undefined;

  return isRetiredHarness(harness, value, loadout);
};

const isRetiredRecord = (directory: string): boolean => {
  try {
    return isRetiredTask(readRecord(directory, 'task.json'));
  } catch {
    return false;
  }
};

const diagnoseSkippedTask = (directory: string, error: unknown, diagnostics: string[]): void => {
  if (isRetiredRecord(directory)) {
    diagnostics.push(
      `Skipped task ${basename(directory)} saved in a retired format; start a fresh task instead.`,
    );

    return;
  }

  diagnostics.push(`Skipped task at ${directory}: ${errorMessage(error)}`);
};

const readScannedTask = (directory: string): Task | undefined => {
  try {
    return readTask(directory);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  // Another process may publish the task after the failed read. A dangling link still fails.
  if (
    lstatSync(join(directory, 'task.json'), { throwIfNoEntry: false }) ||
    !isUnpublishedDirectory(directory)
  ) {
    return readTask(directory);
  }

  return undefined;
};

const readReferencedTask = (
  directory: string,
  taskId: string,
  diagnostics: string[],
): Task | undefined => {
  try {
    const task = readScannedTask(directory);

    if (task?.taskId !== taskId) {
      throw new Error(
        `Missing task.json for referenced continuation ${taskId}. Saved attempt or claim requires inspection.`,
      );
    }

    return task;
  } catch (error) {
    diagnoseSkippedTask(directory, error, diagnostics);

    return undefined;
  }
};

// Recheck late publications without letting broken references hide unrelated tasks.
const addReferencedTasks = (
  root: string,
  tasks: { directory: string; task: Task }[],
  unpublished: Map<string, string>,
  diagnostics: string[],
): void => {
  // Tasks published late are appended here and checked by this same loop.
  for (const { directory, task } of tasks) {
    if (!unpublished.size) {
      return;
    }

    let successor: string | undefined;

    try {
      successor = readSuccessor(directory)?.successorTaskId;
    } catch (error) {
      diagnostics.push(
        `Could not read continuation references at ${directory}: ${errorMessage(error)}`,
      );
    }

    const references = [task.predecessorTaskId, successor];

    for (const referenced of references) {
      if (referenced === undefined || !unpublished.has(referenced)) {
        continue;
      }

      // A continuation may have been published after the scan read its directory.
      const referencedDirectory = join(root, referenced);
      unpublished.delete(referenced);

      const late = readReferencedTask(referencedDirectory, referenced, diagnostics);

      if (late) {
        tasks.push({ directory: referencedDirectory, task: late });
      }
    }
  }
};

const readTaskEntries = (root: string, diagnostics: string[]): Dirent[] | undefined => {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (!isMissingFile(error)) {
      diagnostics.push(`Could not scan tasks at ${root}: ${errorMessage(error)}`);
    }

    return undefined;
  }
};

interface FoundTaskEntry {
  directory: string;
  task: Task;
}

interface UnpublishedTaskEntry {
  name: string;
  directory: string;
}

const scanTaskEntry = (
  root: string,
  entry: Dirent,
  diagnostics: string[],
): FoundTaskEntry | UnpublishedTaskEntry | undefined => {
  const directory = join(root, entry.name);

  try {
    const task = readScannedTask(directory);

    if (!task) {
      return { name: entry.name, directory };
    }

    if (task.taskId !== entry.name) {
      throw new Error('Saved task directory and identity do not match.');
    }

    return { directory, task };
  } catch (error) {
    diagnoseSkippedTask(directory, error, diagnostics);

    return undefined;
  }
};

export const readTasks = (
  root: string,
  diagnostics: string[] = [],
): { directory: string; task: Task }[] => {
  const entries = readTaskEntries(root, diagnostics);

  if (!entries) {
    return [];
  }

  const tasks: { directory: string; task: Task }[] = [];
  const unpublished = new Map<string, string>();

  for (const entry of entries.filter(
    (candidate) => candidate.isDirectory() && candidate.name !== '.admission',
  )) {
    const outcome = scanTaskEntry(root, entry, diagnostics);

    if (!outcome) {
      continue;
    }

    if ('name' in outcome) {
      unpublished.set(outcome.name, outcome.directory);
      continue;
    }

    tasks.push({ directory: outcome.directory, task: outcome.task });
  }

  addReferencedTasks(root, tasks, unpublished, diagnostics);

  for (const [id, directory] of unpublished) {
    diagnostics.push(
      `Skipped unpublished task ${id}; preparation evidence remains at ${directory}.`,
    );
  }

  return tasks;
};

const successorMatchesPredecessor = (successor: Task, predecessor: Task): boolean =>
  successor.taskId !== predecessor.taskId &&
  successor.nativeSessionId === predecessor.nativeSessionId &&
  successor.nativeSessionFile === predecessor.nativeSessionFile;

export const claimSuccessor = (directory: string, successor: Task): void => {
  const predecessor = readTask(directory);
  const existing = readSuccessor(directory);

  if (existing) {
    throw new Error(
      `Task ${predecessor.taskId} already claimed by successor ${existing.successorTaskId}. No retry.`,
    );
  }

  if (
    successor.predecessorTaskId !== predecessor.taskId ||
    !successorMatchesPredecessor(successor, predecessor)
  ) {
    throw new Error('Successor identity does not match its predecessor.');
  }

  try {
    publish(directory, 'successor.json', {
      version: 1,
      predecessorTaskId: predecessor.taskId,
      successorTaskId: successor.taskId,
      nativeSessionId: successor.nativeSessionId,
      nativeSessionFile: successor.nativeSessionFile,
    });
  } catch (error) {
    throw new Error(
      `Claim for successor ${successor.taskId} is uncertain or another successor won. Inspect successor.json; never retry or reclaim by age.`,
      { cause: error },
    );
  }
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
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

export interface EventDetails {
  detail: string;
  stopped?: boolean;
  processId?: number;
}

export const recordEvent = (
  directory: string,
  taskId: string,
  kind: TaskEvent['kind'],
  value: string | EventDetails,
): void => {
  const details: EventDetails = typeof value === 'string' ? { detail: value } : value;

  publish(directory, `${kind}.json`, {
    taskId,
    kind,
    detail: details.detail,
    stopped: details.stopped ?? false,
    at: Date.now(),
    ...(details.processId === undefined ? {} : { processId: details.processId }),
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
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

export const taskEnded = (directory: string, task: Task): boolean =>
  taskEndedEventKinds.some((kind) => readEvent(directory, task.taskId, kind)) ||
  Boolean(readReport(directory, task.taskId));

const submissionIntentSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    id: Type.String({ pattern: '^[a-zA-Z0-9-]{1,128}$' }),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const submissionSchema = Type.Object({
  taskId: Type.String(),
  id: Type.String(),
  state: Type.Union([
    Type.Literal('submitted'),
    Type.Literal('not-delivered'),
    Type.Literal('uncertain'),
  ]),
  detail: Type.String(),
});

export const submissionName = (id: string, suffix: 'intent' | 'observation'): string => {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) {
    throw new Error('Invalid native submission identity.');
  }

  return `submission-${id}-${suffix}.json`;
};

const isMatchingSubmission = (
  value: unknown,
  taskId: string,
  id: string,
): value is Static<typeof submissionSchema> => {
  if (!Value.Check(submissionSchema, value)) {
    return false;
  }

  return value.taskId === taskId && value.id === id;
};

export const readGenericSubmission = (directory: string, taskId: string, id: string) => {
  const intent = readOptionalRecord(directory, submissionName(id, 'intent'));

  if (intent === undefined) {
    return undefined;
  }

  if (
    !Value.Check(submissionIntentSchema, intent) ||
    intent.taskId !== taskId ||
    intent.id !== id
  ) {
    throw new Error('Invalid native submission intent.');
  }

  const observation = readOptionalRecord(directory, submissionName(id, 'observation'));

  if (observation !== undefined && !isMatchingSubmission(observation, taskId, id)) {
    throw new Error('Invalid native submission observation.');
  }

  return {
    intent,
    observation,
    retry: 'Never resubmit this identity; missing observation means uncertain delivery.',
  };
};

export const readPane = (directory: string): string | undefined => {
  const value = readOptionalRecord(directory, 'pane.json');

  if (value === undefined) {
    return undefined;
  }

  const paneId =
    typeof value === 'object' && value !== null && 'paneId' in value ? value.paneId : undefined;

  if (typeof paneId !== 'string' || !paneId) {
    throw new Error('Invalid saved worker pane.');
  }

  return paneId;
};
