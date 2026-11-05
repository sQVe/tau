import { existsSync } from 'node:fs';

import { errorMessage, hasErrorCode } from '../../errors.js';
import { currentTerminalAddress, get, ls } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { checkInboxTarget, sendInboxMessage } from '../../inbox/inbox.js';
import {
  decideAssignment,
  decideTarget,
  leaseRefusal,
  targetChangeRefusal,
} from './answerDecision.js';
import type { AssignmentFact } from './answerDecision.js';
import type { AnswerParameters } from './answerParameters.js';
import { answerPath, formatAnswerReference, publishAnswer } from './answerRecord.js';
import { assignmentPath, readAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { launchErrorResult } from './errorResult.js';
import type { ToolResult } from './errorResult.js';

export interface AnswerRuntime {
  hc: HcRuntime;
}

export interface AnswerRequest {
  parameters: AnswerParameters;
  parentSession: string;
  cwd: string;
}

export interface AnswerStatus {
  status: 'queued';
  assignmentId: string;
  questionId: string;
  answerPath: string;
  terminal: string;
  messageId: string;
}

interface AnswerTarget {
  assignment: Assignment;
  path: string;
  managerTerminal: string;
  terminal: string;
}

const readAssignmentFact = async (path: string): Promise<AssignmentFact> => {
  try {
    const assignment = await readAssignment(path);

    return assignment === undefined ? { kind: 'missing' } : { kind: 'saved', assignment };
  } catch (error) {
    return { kind: 'malformed', message: errorMessage(error) };
  }
};

const readAnswerableAssignment = async (
  parameters: AnswerParameters,
  path: string,
  parentSession: string,
): Promise<Assignment> => {
  const decision = decideAssignment({
    assignmentId: parameters.assignmentId,
    questionId: parameters.questionId,
    path,
    parentSession,
    read: await readAssignmentFact(path),
  });

  if (decision.kind === 'refused') {
    throw new Error(decision.reason);
  }

  return decision.assignment;
};

// hc ls names each live terminal's parent but not its labels, so each child is read with get.
const findWorkerTerminal = async (
  hc: HcRuntime,
  managerTerminal: string,
  path: string,
): Promise<string> => {
  const list = await ls(hc);
  const children = list.terminals.filter((terminal) => terminal.parent === managerTerminal);

  const terminals = await Promise.all(children.map((child) => get(hc, child.address)));
  const decision = decideTarget({ managerTerminal, path, terminals });

  if (decision.kind === 'refused') {
    throw new Error(decision.reason);
  }

  return decision.terminal;
};

const findTarget = async (
  runtime: AnswerRuntime,
  request: AnswerRequest,
): Promise<AnswerTarget> => {
  const managerTerminal = currentTerminalAddress();

  if (managerTerminal === undefined) {
    throw new Error('Answering a worker requires HC_TERMINAL_ID. Start Tau inside an hc terminal.');
  }

  const path = assignmentPath(request.parameters.assignmentId);

  const assignment = await readAnswerableAssignment(
    request.parameters,
    path,
    request.parentSession,
  );

  const terminal = await findWorkerTerminal(runtime.hc, managerTerminal, path);

  return { assignment, path, managerTerminal, terminal };
};

const checkTarget = async (
  hc: HcRuntime,
  target: AnswerTarget,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const inbox = await checkInboxTarget({ hc, target: target.terminal, family: 'answer', signal });

  const leaseProblem = leaseRefusal({
    terminal: inbox.terminal,
    leaseSessionId: inbox.sessionId,
    workerSessionId: target.assignment.session.id,
  });

  if (leaseProblem !== undefined) {
    throw new Error(leaseProblem);
  }

  const changeProblem = targetChangeRefusal({
    managerTerminal: target.managerTerminal,
    path: target.path,
    terminal: await get(hc, target.terminal),
  });

  if (changeProblem !== undefined) {
    throw new Error(changeProblem);
  }
};

const queuedResult = (details: AnswerStatus): ToolResult<AnswerStatus> => ({
  content: [
    {
      type: 'text',
      text: `Queued answer ${details.answerPath} for ${details.terminal} as message ${details.messageId}. Queued is not a read receipt. End your turn to wait for the worker.`,
    },
  ],
  details,
});

const savedNotQueued = (path: string, error: unknown): ToolResult<undefined> =>
  launchErrorResult(
    new Error(
      `Answer saved at ${path}, queueing not confirmed: ${errorMessage(error)} Nothing is retried; do not answer this question again.`,
      { cause: error },
    ),
  );

// Publication links the final file before it syncs the folder and removes the temporary file, so a
// failure can leave this call's answer saved. An existing answer from an earlier call stays refused.
const isSavedByFailedPublish = (error: unknown, path: string): boolean => {
  const isExistingAnswer = error instanceof Error && hasErrorCode(error.cause, 'EEXIST');

  return !isExistingAnswer && existsSync(path);
};

const publish = (
  assignmentId: string,
  questionId: string,
  answer: string,
): ToolResult<undefined> | undefined => {
  try {
    publishAnswer({ version: 1, assignmentId, questionId, answeredAt: Date.now(), answer });
  } catch (error) {
    const path = answerPath(assignmentId, questionId);

    return isSavedByFailedPublish(error, path)
      ? savedNotQueued(path, error)
      : launchErrorResult(error);
  }

  return undefined;
};

export const executeAnswer = async (
  runtime: AnswerRuntime,
  request: AnswerRequest,
  signal: AbortSignal | undefined,
): Promise<ToolResult<AnswerStatus | undefined>> => {
  const { assignmentId, questionId, answer } = request.parameters;
  let target: AnswerTarget;

  try {
    target = await findTarget(runtime, request);
    await checkTarget(runtime.hc, target, signal);
    signal?.throwIfAborted();
  } catch (error) {
    return launchErrorResult(error);
  }

  const publishFailure = publish(assignmentId, questionId, answer);

  if (publishFailure !== undefined) {
    return publishFailure;
  }

  const path = answerPath(assignmentId, questionId);

  try {
    const sent = await sendInboxMessage({
      hc: runtime.hc,
      target: target.terminal,
      family: 'answer',
      text: formatAnswerReference(assignmentId, questionId),
      cwd: request.cwd,
      signal,
      expectedSessionId: target.assignment.session.id,
    });

    return queuedResult({
      status: 'queued',
      assignmentId,
      questionId,
      answerPath: path,
      terminal: sent.terminal,
      messageId: sent.messageId,
    });
  } catch (error) {
    return savedNotQueued(path, error);
  }
};
