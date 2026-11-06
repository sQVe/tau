import { errorMessage } from '../../errors.js';
import { currentTerminalAddress, get, ls } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { checkInboxTarget, sendInboxMessage } from '../../inbox/inbox.js';
import type { InboxSender } from '../../inbox/inbox.js';
import { PublishError } from '../../record.js';
import {
  decideAssignment,
  decideTarget,
  leaseRefusal,
  targetChangeRefusal,
} from './answerDecision.js';
import type { AssignmentFact } from './answerDecision.js';
import type { AnswerParameters } from './answerParameters.js';
import { answerPath, formatAnswerReference, publishAnswer, readAnswer } from './answerRecord.js';
import type { AnswerRecord } from './answerRecord.js';
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

const answerSender: InboxSender = {
  toolName: 'subagent_answer',
  recovery: 'The worker has no live inbox; restart the worker on a current Tau.',
};

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

const findTarget = async (hc: HcRuntime, request: AnswerRequest): Promise<AnswerTarget> => {
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

  const terminal = await findWorkerTerminal(hc, managerTerminal, path);

  return { assignment, path, managerTerminal, terminal };
};

const checkTarget = async (
  hc: HcRuntime,
  target: AnswerTarget,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const inbox = await checkInboxTarget({
    hc,
    target: target.terminal,
    sender: answerSender,
    signal,
  });

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
    terminal: inbox.snapshot,
  });

  if (changeProblem !== undefined) {
    throw new Error(changeProblem);
  }
};

const readSavedAnswer = async (
  assignmentId: string,
  questionId: string,
): Promise<AnswerRecord | undefined> => {
  const read = await readAnswer(assignmentId, questionId);

  if (read.kind === 'refused') {
    throw new Error(read.reason);
  }

  return read.kind === 'answered' ? read.record : undefined;
};

const deliveryText = (
  details: AnswerStatus,
  saved: AnswerRecord | undefined,
  answer: string,
): string => {
  const delivery = `${details.answerPath} for ${details.terminal} as message ${details.messageId}.`;

  if (saved === undefined) {
    return `Queued answer ${delivery}`;
  }

  const ignored =
    saved.answer === answer ? '' : ' The new answer text was ignored; the saved answer stays.';

  return `Resent the saved answer ${delivery}${ignored}`;
};

const queuedResult = (
  details: AnswerStatus,
  saved: AnswerRecord | undefined,
  answer: string,
): ToolResult<AnswerStatus> => ({
  content: [
    {
      type: 'text',
      text: `${deliveryText(details, saved, answer)} Queued is not a read receipt. End your turn to wait for the worker.`,
    },
  ],
  details,
});

const savedNotQueued = (path: string, error: unknown): ToolResult<undefined> =>
  launchErrorResult(
    new Error(
      `Answer saved at ${path}, queueing not confirmed: ${errorMessage(error)} Nothing is retried; call subagent_answer again for this question to resend the saved answer.`,
      { cause: error },
    ),
  );

const isSavedByFailedPublish = (error: unknown): boolean =>
  error instanceof PublishError && error.failure === 'linked';

const publish = (
  assignmentId: string,
  questionId: string,
  answer: string,
): ToolResult<undefined> | undefined => {
  try {
    publishAnswer({ version: 1, assignmentId, questionId, answeredAt: Date.now(), answer });
  } catch (error) {
    const path = answerPath(assignmentId, questionId);

    return isSavedByFailedPublish(error) ? savedNotQueued(path, error) : launchErrorResult(error);
  }

  return undefined;
};

const queueAnswer = async (
  hc: HcRuntime,
  request: AnswerRequest,
  target: AnswerTarget,
  saved: AnswerRecord | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult<AnswerStatus | undefined>> => {
  const { assignmentId, questionId, answer } = request.parameters;
  const path = answerPath(assignmentId, questionId);

  try {
    const sent = await sendInboxMessage({
      hc,
      target: target.terminal,
      family: 'answer',
      sender: answerSender,
      text: formatAnswerReference(assignmentId, questionId),
      cwd: request.cwd,
      signal,
      expectedSessionId: target.assignment.session.id,
    });

    const details: AnswerStatus = {
      status: 'queued',
      assignmentId,
      questionId,
      answerPath: path,
      terminal: sent.terminal,
      messageId: sent.messageId,
    };

    return queuedResult(details, saved, answer);
  } catch (error) {
    return savedNotQueued(path, error);
  }
};

// The worker can save another question or its report during the terminal lookups, so the
// assignment is read again right before the answer is saved.
export const executeAnswer = async (
  runtime: AnswerRuntime,
  request: AnswerRequest,
  signal: AbortSignal | undefined,
): Promise<ToolResult<AnswerStatus | undefined>> => {
  const { assignmentId, questionId, answer } = request.parameters;
  const hc: HcRuntime = signal === undefined ? runtime.hc : { ...runtime.hc, signal };
  let target: AnswerTarget;
  let saved: AnswerRecord | undefined;

  try {
    target = await findTarget(hc, request);
    await checkTarget(hc, target, signal);
    saved = await readSavedAnswer(assignmentId, questionId);
    await readAnswerableAssignment(request.parameters, target.path, request.parentSession);
    signal?.throwIfAborted();
  } catch (error) {
    return launchErrorResult(error);
  }

  if (saved === undefined) {
    const publishFailure = publish(assignmentId, questionId, answer);

    if (publishFailure !== undefined) {
      return publishFailure;
    }
  }

  return queueAnswer(hc, request, target, saved, signal);
};
