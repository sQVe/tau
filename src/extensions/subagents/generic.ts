import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { hasErrorCode, isMissingFile } from '../../errors/index.js';
import { assignmentContractFor, handoffContract } from './handoff.js';
import {
  acceptReport,
  publish,
  readGenericSubmission,
  readOptionalRecord,
  readReport,
  submissionName,
} from './records.js';
import { isGenericLoadout } from './types.js';
import type { SubmissionState, Task } from './types.js';

const reportDirectory = (task: Task): string => {
  if (!isGenericLoadout(task.loadout)) {
    throw new Error('Only generic workers use report files.');
  }

  return join(task.loadout.cwd, '.tau', 'workers', task.taskId);
};

export const genericReportPath = (task: Task): string => join(reportDirectory(task), 'report.md');

const reportAreaIsIntact = (task: Task): boolean =>
  [task.loadout.cwd, reportDirectory(task)].every((path) => realpathSync(path) === path);

// A 10000-byte report always fits the 64000-byte receipt even when every byte JSON-escapes.
const reportByteLimit = 10_000;

// A symlinked folder would make preparation write outside the worker's cwd.
const ensureRealDirectory = (path: string): void => {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }

  if (!lstatSync(path).isDirectory()) {
    throw new Error(`${path} must be a directory, not a symbolic link or file.`);
  }
};

// The * rule keeps .tau/ out of Git in any repository, whatever the repository ignores.
const ensureIgnoreRule = (folder: string): void => {
  const descriptor = openSync(
    join(folder, '.gitignore'),
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );

  try {
    const content = readFileSync(descriptor, 'utf8');

    if (!content.split('\n').some((line) => line.trim() === '*')) {
      writeFileSync(descriptor, content === '' || content.endsWith('\n') ? '*\n' : '\n*\n');
    }
  } finally {
    closeSync(descriptor);
  }
};

export const prepareGenericReport = (task: Task): void => {
  const directory = reportDirectory(task);
  const workers = dirname(directory);
  const tau = dirname(workers);

  if (realpathSync(task.loadout.cwd) !== task.loadout.cwd) {
    throw new Error('The worker cwd changed.');
  }

  ensureRealDirectory(tau);
  ensureIgnoreRule(tau);
  ensureRealDirectory(workers);
  mkdirSync(directory, { mode: 0o700 });
};

export const genericPrompt = (task: Task): string => {
  const path = genericReportPath(task);

  return `${task.loadout.instructions}\n\nTask: ${task.taskId}\n${task.task}\n\n${assignmentContractFor(task.loadout.role)}${handoffContract}\n\nDeadline: ${new Date(task.deadline).toISOString()}. Work only within the assigned scope. Preserve unrelated work. Do not commit, merge, reset, or run extra model trials. Do not resume old conversations. Ask your manager for clarification or additional help in plain text. Waiting for answers or native approvals does not extend this deadline. Do not answer approval dialogs automatically.\n\nPublish your final plain text or Markdown report at ${path}. This report area is already authorized; do not widen your sandbox. If you cannot write it, tell the manager and report the limit in text. No report means incomplete, even if you finish the task.\nWrite the complete UTF-8 report to a new file named report.partial in that directory using exclusive creation. Close it, then publish report.md with a create-only hard link and remove report.partial. Never overwrite an existing file. Do not write report.md incrementally. Maximum size: 10000 bytes. Use this exact envelope, with your handoff between the headers and final line:\nTask: ${task.taskId}\nOutcome: success|failure|incomplete\n\nYour report with the Changes, Evidence, Decisions, and Concerns sections. Choose exactly one outcome above.\n\nEnd task: ${task.taskId}\n\nThe final End task line must end with a newline. Publish once. A saved receipt proves report delivery, not answer correctness. Native controls remain in force; Tau does not certify their enforcement.`;
};

const reportMetadataFields = ['size', 'mtimeNs', 'ctimeNs'] as const;

const metadataChanged = (before: BigIntStats, after: BigIntStats, current: BigIntStats): boolean =>
  reportMetadataFields.some(
    (field) => before[field] !== after[field] || after[field] !== current[field],
  );

const reportIdentityChanged = (
  length: number,
  before: BigIntStats,
  after: BigIntStats,
  current: BigIntStats,
): boolean => {
  const limit = BigInt(reportByteLimit);
  const oversized = length > reportByteLimit || after.size > limit || current.size > limit;
  const replaced =
    current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino;

  return oversized || replaced;
};

const readReportContent = (descriptor: number, path: string): string | undefined => {
  const before = fstatSync(descriptor, { bigint: true });

  if (!before.isFile() || before.size > BigInt(reportByteLimit)) {
    throw new Error(`Report must be a regular file of at most ${reportByteLimit} bytes.`);
  }

  const buffer = Buffer.alloc(reportByteLimit + 1);
  let length = 0;

  while (length < buffer.length) {
    const count = readSync(descriptor, buffer, {
      offset: length,
      length: buffer.length - length,
      position: length,
    });

    if (!count) {
      break;
    }

    length += count;
  }

  const after = fstatSync(descriptor, { bigint: true });
  const current = lstatSync(path, { bigint: true });

  if (reportIdentityChanged(length, before, after, current)) {
    throw new Error('Report file identity changed or is oversized.');
  }

  // An in-progress native write is not a completed report or a reason to terminate the task.
  if (BigInt(length) !== before.size || metadataChanged(before, after, current)) {
    return undefined;
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
};

const readPublishedReport = (path: string): string | undefined => {
  let descriptor: number;

  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }

  try {
    return readReportContent(descriptor, path);
  } finally {
    closeSync(descriptor);
  }
};

const reportOutcome = (content: string, taskId: string): string | undefined => {
  const prefix = `Task: ${taskId}\nOutcome: `;
  const suffix = `\nEnd task: ${taskId}\n`;
  const outcome = content.slice(prefix.length).split('\n', 1)[0];

  if (content.includes('\n') && content.split('\n', 1)[0] !== `Task: ${taskId}`) {
    throw new Error('Report has the wrong task identity.');
  }

  // Native write tools may publish incrementally despite the requested hard-link protocol.
  // Wait within the original deadline; never accept a missing completion trailer.
  if (!content.endsWith(suffix)) {
    return undefined;
  }

  if (
    !content.startsWith(prefix) ||
    !['success', 'failure', 'incomplete'].includes(outcome ?? '') ||
    !content.slice(prefix.length + (outcome?.length ?? 0), -suffix.length).trim()
  ) {
    throw new Error('Report lacks an explicit outcome and evidence.');
  }

  return outcome;
};

export const acceptGenericReport = (directory: string, task: Task): boolean => {
  if (readReport(directory, task.taskId)) {
    return true;
  }

  const path = genericReportPath(task);

  if (!reportAreaIsIntact(task)) {
    throw new Error('The report area changed.');
  }

  const content = readPublishedReport(path);

  if (content === undefined) {
    return false;
  }

  const outcome = reportOutcome(content, task.taskId);

  if (!outcome) {
    return false;
  }

  const value = {
    taskId: task.taskId,
    outcome,
    summary: content,
    evidence: [path],
  };

  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64_000) {
    throw new Error(
      'Report content is too large once JSON-escaped; reduce control characters or size.',
    );
  }

  acceptReport(directory, task.taskId, value);

  return true;
};

const nativeReferenceSchema = Type.Object({
  taskId: Type.String(),
  reference: Type.Object({
    kind: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.String({ minLength: 1, maxLength: 8000 }),
  }),
});

export const readGenericReference = (directory: string, taskId: string) => {
  const value = readOptionalRecord(directory, 'nativeReference.json');

  if (value === undefined) {
    return undefined;
  }

  if (!Value.Check(nativeReferenceSchema, value) || value.taskId !== taskId) {
    throw new Error('Invalid saved opaque native reference.');
  }

  return value.reference;
};

const blockedSubmission = (error: unknown): boolean => {
  if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(error.stderr);

    return Value.Check(
      Type.Object({ error: Type.Object({ code: Type.Literal('agent_blocked') }) }),
      parsed,
    );
  } catch {
    return false;
  }
};

export interface GenericSubmission {
  id: string;
  text: string;
  send: () => Promise<string>;
}

export const submitGenericText = async (
  directory: string,
  task: Task,
  submission: GenericSubmission,
) => {
  const { id, text, send } = submission;
  const previous = readGenericSubmission(directory, task.taskId, id);

  if (previous) {
    const expected = { taskId: task.taskId, id, text };

    if (JSON.stringify(previous.intent) !== JSON.stringify(expected)) {
      throw new Error('Conflicting native submission identity.');
    }

    return previous;
  }

  publish(directory, submissionName(id, 'intent'), { taskId: task.taskId, id, text });
  let state: SubmissionState = 'submitted';
  let detail =
    'Herdr submitted text. Task acceptance, acknowledgement, and model selection are not verified.';

  try {
    await send();
  } catch (error) {
    state = blockedSubmission(error) ? 'not-delivered' : 'uncertain';
    detail = `${String(error).slice(0, 4000)} No automatic retry.`;
  }

  publish(directory, submissionName(id, 'observation'), { taskId: task.taskId, id, state, detail });

  return readGenericSubmission(directory, task.taskId, id);
};
