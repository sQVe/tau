import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import type { InboxSendResult } from '../../inbox/inbox.js';
import type { AnswerParameters } from './answerParameters.js';
import { assignmentPath, readAssignment } from './assignment.js';
import { launchErrorResult } from './errorResult.js';
import type { ToolResult } from './errorResult.js';
import { readWorkerChildren } from './workerDelivery.js';

export interface AnswerRequest {
  parameters: AnswerParameters;
  parentSession: string;
}

const restartRecovery =
  'Nothing was queued. A worker without a live inbox needs a restart on a current Tau before it can get an answer.';

// The worker checks the question again when the answer arrives; this check gives early feedback.
const checkAnswerable = async (request: AnswerRequest): Promise<void> => {
  const { assignmentId, questionId } = request.parameters;
  const assignment = await readAssignment(assignmentPath(assignmentId));

  if (assignment === undefined) {
    throw new Error(`No assignment ${assignmentId}. Nothing was queued.`);
  }

  if (assignment.parentSession !== request.parentSession) {
    throw new Error(`Assignment ${assignmentId} belongs to another manager. Nothing was queued.`);
  }

  if (assignment.report !== null) {
    throw new Error(`Assignment ${assignmentId} already has a report. Nothing was queued.`);
  }

  if (assignment.questions.at(-1)?.questionId !== questionId) {
    throw new Error(
      `Question ${questionId} is not the open question of assignment ${assignmentId}. Nothing was queued.`,
    );
  }
};

const findWorkerTerminal = async (hc: HcRuntime, assignmentId: string): Promise<string> => {
  const managerTerminal = currentTerminalAddress();

  if (managerTerminal === undefined) {
    throw new Error('Answering a worker requires HC_TERMINAL_ID. Start Tau inside an hc terminal.');
  }

  const children = await readWorkerChildren(hc, managerTerminal);

  const worker = children.find(
    ({ terminal, assignment }) =>
      terminal.state === 'live' &&
      assignment.kind === 'saved' &&
      assignment.assignment.assignmentId === assignmentId,
  );

  if (worker === undefined) {
    throw new Error(
      `No live worker terminal carries assignment ${assignmentId}. ${restartRecovery}`,
    );
  }

  return worker.terminal.address;
};

const resultText = (sent: InboxSendResult): string =>
  sent.status === 'queued'
    ? `Queued the answer for ${sent.terminal} as message ${sent.messageId}. Queued is not a read receipt. End your turn to wait for the worker.`
    : (sent.note ?? `Acceptance unknown for message ${sent.messageId}.`);

// The message ID is the question ID, so a repeated answer reaches the worker as the same message.
export const executeAnswer = async (
  hc: HcRuntime,
  request: AnswerRequest,
): Promise<ToolResult<InboxSendResult | undefined>> => {
  const { assignmentId, questionId, answer } = request.parameters;

  try {
    await checkAnswerable(request);

    const sent = await sendInboxMessage({
      hc,
      target: await findWorkerTerminal(hc, assignmentId),
      body: {
        family: 'answer',
        payload: { assignmentId, questionId, parentSession: request.parentSession, answer },
      },
      messageId: questionId,
      refusal: restartRecovery,
    });

    return { content: [{ type: 'text', text: resultText(sent) }], details: sent };
  } catch (error) {
    return launchErrorResult(error);
  }
};
