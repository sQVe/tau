import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { acceptReport, publish, readOptionalRecord, readReport } from './records.js';
import { isGenericLoadout } from './types.js';
import type { Task } from './types.js';

export const genericReportPath = (task: Task): string => {
  if (!isGenericLoadout(task.loadout)) {
    throw new Error('Only generic workers use report files.');
  }

  return join(task.loadout.reportDirectory, `.tau-worker-${task.taskId}`, 'report.md');
};

// A 10000-byte report always fits the 64000-byte receipt even when every byte JSON-escapes.
export const reportByteLimit = 10_000;

export const prepareGenericReport = (task: Task): void => {
  if (
    !isGenericLoadout(task.loadout) ||
    realpathSync(task.loadout.reportDirectory) !== task.loadout.reportDirectory
  ) {
    throw new Error('The approved report area changed.');
  }

  mkdirSync(join(task.loadout.reportDirectory, `.tau-worker-${task.taskId}`), { mode: 0o700 });
};

export const genericPrompt = (task: Task): string => {
  const path = genericReportPath(task);

  return `${task.loadout.instructions}\n\nTask: ${task.taskId}\n${task.task}\n\nDeadline: ${new Date(task.deadline).toISOString()}. Work only within the assigned scope. Preserve unrelated work. Do not commit, merge, reset, or run extra model trials. Do not resume old conversations. Ask your manager for clarification or additional help in plain text; no Tau nesting channel is available. Waiting for answers or native approvals does not extend this deadline. Do not answer approval dialogs automatically.\n\nPublish your final plain text or Markdown report at ${path}. This report area is already authorized; do not widen your sandbox. If you cannot write it, tell the manager and report the limit in text. No report means incomplete, even if you finish the task.\nWrite the complete UTF-8 report to a new file named report.partial in that directory using exclusive creation. Close it, then publish report.md with a create-only hard link and remove report.partial. Never overwrite an existing file. Do not write report.md incrementally. Maximum size: 10000 bytes. Use this exact envelope, with your evidence between the headers and final line:\nTask: ${task.taskId}\nOutcome: success|failure|incomplete\n\nYour report and evidence. Choose exactly one outcome above.\n\nEnd task: ${task.taskId}\n\nThe final End task line must end with a newline. Publish once. A saved receipt proves report delivery, not answer correctness. Native controls remain in force; Tau does not certify their enforcement.`;
};

const reportMetadataFields = ['size', 'mtimeNs', 'ctimeNs'] as const;

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

  if (
    length > reportByteLimit ||
    after.size > BigInt(reportByteLimit) ||
    current.size > BigInt(reportByteLimit) ||
    current.isSymbolicLink() ||
    current.dev !== before.dev ||
    current.ino !== before.ino
  ) {
    throw new Error('Report file identity changed or is oversized.');
  }

  // An in-progress native write is not a completed report or a reason to terminate the task.
  if (
    BigInt(length) !== before.size ||
    reportMetadataFields.some(
      (field) => before[field] !== after[field] || after[field] !== current[field],
    )
  ) {
    return undefined;
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
};

const readPublishedReport = (path: string): string | undefined => {
  let descriptor: number;

  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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

  if (
    !isGenericLoadout(task.loadout) ||
    realpathSync(task.loadout.reportDirectory) !== task.loadout.reportDirectory ||
    realpathSync(join(task.loadout.reportDirectory, `.tau-worker-${task.taskId}`)) !==
      join(task.loadout.reportDirectory, `.tau-worker-${task.taskId}`)
  ) {
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

const submissionName = (id: string, suffix: string): string => {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) {
    throw new Error('Invalid native submission identity.');
  }

  return `submission-${id}-${suffix}.json`;
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

  if (
    observation !== undefined &&
    (!Value.Check(submissionSchema, observation) ||
      observation.taskId !== taskId ||
      observation.id !== id)
  ) {
    throw new Error('Invalid native submission observation.');
  }

  return {
    intent,
    observation,
    retry: 'Never resubmit this identity; missing observation means uncertain delivery.',
  };
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

export const submitGenericText = async (
  directory: string,
  task: Task,
  id: string,
  text: string,
  send: () => Promise<string>,
) => {
  const previous = readGenericSubmission(directory, task.taskId, id);

  if (previous) {
    const expected = { taskId: task.taskId, id, text };

    if (JSON.stringify(previous.intent) !== JSON.stringify(expected)) {
      throw new Error('Conflicting native submission identity.');
    }

    return previous;
  }

  publish(directory, submissionName(id, 'intent'), { taskId: task.taskId, id, text });
  let state: 'submitted' | 'not-delivered' | 'uncertain' = 'submitted';
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
