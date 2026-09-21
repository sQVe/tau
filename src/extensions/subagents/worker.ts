// Running-child settlement adapted from pi-interactive-subagents c3e8b53, subagent-done.ts. See LICENSE.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { processExists } from './cancellation.js';
import { checkWorkerRuntime } from './loadout.js';
import { workerPrompt } from './profiles.js';
import {
  acceptAcknowledgement,
  acceptQuestion,
  readReply,
  validateQuestion,
} from './questionRecords.js';
import { acceptReport, readEvent, readRecord, readTask, recordEvent } from './records.js';
import { textLimit } from './types.js';
import type { Question, Report, Task } from './types.js';

const reportParameters = Type.Object({
  outcome: StringEnum(['success', 'failure', 'incomplete']),
  summary: Type.String({ minLength: 1, maxLength: 32_000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 32_000 }), { maxItems: 100 }),
});

type ReportInput = Static<typeof reportParameters>;

interface WorkerState {
  directory: string;
  task: Task | undefined;
  accepted: boolean;
  reported: boolean;
  settled: boolean;
  kickoff: ReturnType<typeof setInterval> | undefined;
  pendingQuestion: Question | undefined;
  parentWatch: ReturnType<typeof setInterval> | undefined;
  removeNotificationListener: (() => void) | undefined;
}

const parentRunning = (processId: number): boolean => {
  try {
    return processExists(processId);
  } catch {
    // Errors such as EPERM do not prove that the parent exited.
    return true;
  }
};

const hasRunningTask = (state: WorkerState): state is WorkerState & { task: Task } =>
  state.task !== undefined && state.accepted && !state.settled;

const isTaskActive = (state: WorkerState): state is WorkerState & { task: Task } =>
  hasRunningTask(state) && !state.reported;

const matchesNativeSession = (task: Task, context: ExtensionContext): boolean =>
  context.sessionManager.getSessionId() === task.nativeSessionId &&
  context.sessionManager.getSessionFile() === task.nativeSessionFile;

const readChildren = (pi: ExtensionAPI): { active: number; uncertain: string[] } => {
  const state = { active: 0, uncertain: [] as string[] };
  pi.events.emit('tau:worker-children', state);

  return state;
};

const hasMessageField = (value: unknown): value is { message: unknown } =>
  typeof value === 'object' && value !== null && 'message' in value;

const isChildNotification = (value: unknown): value is { message: string } =>
  hasMessageField(value) && typeof value.message === 'string';

const handleChildNotification = (pi: ExtensionAPI, state: WorkerState, value: unknown): void => {
  if (!isTaskActive(state) || !isChildNotification(value)) {
    return;
  }

  // A child result is evidence, never a reply to this worker's pending parent question.
  pi.sendMessage(
    { customType: 'tau-worker-child', content: value.message, display: true },
    state.pendingQuestion
      ? { deliverAs: 'nextTurn' }
      : { deliverAs: 'followUp', triggerTurn: true },
  );
};

const parentGone = (state: WorkerState, task: Task, parentProcess: number): boolean =>
  !parentRunning(parentProcess) || Boolean(readEvent(state.directory, task.taskId, 'parentClosed'));

const shouldEndParentWait = (state: WorkerState, task: Task, parentProcess: number): boolean =>
  Boolean(state.pendingQuestion) && !state.settled && parentGone(state, task, parentProcess);

const startParentWatch = (
  state: WorkerState,
  task: Task,
  parentProcess: number,
  context: ExtensionContext,
): void => {
  // A closed or exited parent cannot reply, so waiting would keep this worker open forever.
  // Start watching before publication so an uncertain save still ends the wait.
  // ponytail: PID reuse can hide parent exit; compare process start times if that shows up.
  state.parentWatch = setInterval(() => {
    if (!shouldEndParentWait(state, task, parentProcess)) {
      return;
    }

    clearInterval(state.parentWatch);
    state.settled = true;

    try {
      recordEvent(state.directory, task.taskId, 'settled', {
        detail:
          'Parent closed or exited while this worker waited for a reply. No reply can arrive.',
        stopped: true,
      });
    } finally {
      context.shutdown();
    }
  }, 1000);
};

const askParent = (
  state: WorkerState,
  questionText: string,
  context: ExtensionContext,
): Promise<AgentToolResult<Question>> => {
  if (!isTaskActive(state) || state.pendingQuestion) {
    throw new Error('This worker has no active task available for a question.');
  }

  // oxlint-disable-next-line node/no-process-env -- The parent binds its process identity through the pane environment.
  const parentProcess = Number(process.env.TAU_PARENT_PROCESS);

  if (!Number.isSafeInteger(parentProcess) || parentProcess <= 0) {
    throw new Error('This worker has no parent process to ask.');
  }

  const task = state.task;
  const question = validateQuestion(
    {
      version: 1,
      taskId: task.taskId,
      questionId: randomUUID(),
      question: questionText,
    },
    task.taskId,
  );

  // Keep waiting after uncertain publication rather than generate another question identity.
  state.pendingQuestion = question;
  startParentWatch(state, task, parentProcess, context);
  acceptQuestion(state.directory, task.taskId, question);

  return Promise.resolve({
    content: [
      {
        type: 'text' as const,
        text: 'Question saved for the parent. Wait for a validated reply; do not continue or assume an answer.',
      },
    ],
    details: question,
    terminate: true,
  });
};

const handleInput = (
  state: WorkerState,
  event: InputEvent,
  context: ExtensionContext,
): InputEventResult | undefined => {
  if (!state.accepted && event.source === 'extension') {
    return { action: 'continue' };
  }

  try {
    if (!isTaskActive(state) || state.pendingQuestion === undefined) {
      return { action: 'handled' };
    }

    const task = state.task;
    const pendingQuestion = state.pendingQuestion;

    if (!matchesNativeSession(task, context)) {
      return { action: 'handled' };
    }

    const reply = readReply(state.directory, task.taskId, pendingQuestion.questionId);

    if (!reply) {
      return { action: 'handled' };
    }

    const reference = {
      version: 1,
      taskId: task.taskId,
      questionId: pendingQuestion.questionId,
      replyId: reply.replyId,
    };

    if (event.text !== `TAU_REPLY ${JSON.stringify(reference)}`) {
      return { action: 'handled' };
    }

    acceptAcknowledgement(state.directory, task.taskId, reference);
    state.pendingQuestion = undefined;
    clearInterval(state.parentWatch);

    return {
      action: 'transform',
      text: `Parent clarification for the original task only. Scope, safety settings and deadline are unchanged.\n\n${reply.reply}`,
    };
  } catch (error) {
    context.ui.notify(`Reply refused: ${String(error)}. No automatic retry.`, 'error');

    return { action: 'handled' };
  }
};

const keepEvidence = (evidence: string[], note: string): string[] => {
  const kept = note ? evidence.slice(0, 99) : evidence;

  if (!note) {
    return kept;
  }

  const dropped = evidence.length - kept.length;
  const marker = dropped ? `Dropped ${dropped} evidence entries for this note.\n` : '';

  return [...kept, `${marker}${note}`.slice(0, textLimit)];
};

const reportToParent = (
  state: WorkerState,
  parameters: ReportInput,
  pi: ExtensionAPI,
): Promise<AgentToolResult<Report>> => {
  if (!isTaskActive(state)) {
    throw new Error('This worker has no accepted active task.');
  }

  const descendants = readChildren(pi);

  if (descendants.active) {
    throw new Error(
      'Active children remain. Wait for completion or request bounded cancellation before reporting.',
    );
  }

  const task = state.task;

  // A full summary must never cost the worker its handover.
  const note = descendants.uncertain.join('\n');
  const report = acceptReport(state.directory, task.taskId, {
    ...parameters,
    evidence: keepEvidence(parameters.evidence, note),
    taskId: task.taskId,
  });
  state.reported = true;

  return Promise.resolve({
    content: [{ type: 'text' as const, text: 'Handover durably accepted. Stop working.' }],
    details: report,
    terminate: true,
  });
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';

const isDispatchForTask = (dispatch: unknown, taskId: string): boolean =>
  isObjectRecord(dispatch) && 'taskId' in dispatch && dispatch.taskId === taskId;

const startDispatchWatch = (
  pi: ExtensionAPI,
  state: WorkerState,
  task: Task,
  context: ExtensionContext,
): void => {
  state.kickoff = setInterval(() => {
    if (!state.task) {
      return;
    }

    if (!existsSync(join(state.directory, 'dispatch.json'))) {
      return;
    }

    clearInterval(state.kickoff);

    try {
      const dispatch = readRecord(state.directory, 'dispatch.json');

      if (!isDispatchForTask(dispatch, task.taskId)) {
        throw new Error('Invalid task dispatch.');
      }

      pi.sendUserMessage(workerPrompt(task));
    } catch (error) {
      recordEvent(state.directory, task.taskId, 'startupFailure', String(error));
      context.shutdown();
    }
  }, 50);
};

const refuseAcceptedTask = (state: WorkerState, task: Task, context: ExtensionContext): void => {
  if (!readEvent(state.directory, task.taskId, 'continuationRefused')) {
    recordEvent(
      state.directory,
      task.taskId,
      'continuationRefused',
      'Native continuation by restarting an accepted task is refused. A new follow-up requires final handover and confirmed parent cleanup.',
    );
  }

  context.shutdown();
};

const startWorker = async (
  pi: ExtensionAPI,
  state: WorkerState,
  context: ExtensionContext,
): Promise<void> => {
  try {
    const task = readTask(state.directory);
    state.task = task;

    if (
      context.sessionManager.getSessionId() !== task.nativeSessionId ||
      context.sessionManager.getSessionFile() !== task.nativeSessionFile
    ) {
      throw new Error('Worker native session does not match its task.');
    }

    if (readEvent(state.directory, task.taskId, 'accepted')) {
      refuseAcceptedTask(state, task, context);

      return;
    }

    // Only the parent enforces the task deadline; wall-clock records are for display and recovery.
    await checkWorkerRuntime(task.loadout, pi, context);
    recordEvent(state.directory, task.taskId, 'ready', {
      detail: 'Saved model, tools, cwd, and CC Safety Net checked.',
      processId: process.pid,
    });
    startDispatchWatch(pi, state, task, context);
  } catch (error) {
    const task = state.task;

    if (task && !readEvent(state.directory, task.taskId, 'startupFailure')) {
      recordEvent(state.directory, task.taskId, 'startupFailure', String(error));
    }

    context.ui.notify(`Worker refused: ${String(error)}`, 'error');
    context.shutdown();
  }
};

const callsReportAlone = (
  assistant: ReturnType<ExtensionContext['sessionManager']['getBranch']>[number] | undefined,
): boolean =>
  assistant?.type === 'message' &&
  assistant.message.role === 'assistant' &&
  assistant.message.content.filter((block) => block.type === 'toolCall').length === 1;

const handleToolCall = (
  state: WorkerState,
  event: ToolCallEvent,
  context: ExtensionContext,
): ToolCallEventResult | undefined => {
  if (!isTaskActive(state) || state.pendingQuestion) {
    return {
      block: true,
      reason: 'Worker task is inactive or waiting for a parent reply.',
      terminate: true,
    };
  }

  // The bundled questionnaire reconciler may restore this tool each turn. Workers must ask the parent instead.
  if (event.toolName === 'ask_user_question') {
    return {
      block: true,
      reason:
        'Use subagent_question to ask the parent. Direct worker questionnaires are unavailable.',
    };
  }

  if (event.toolName !== 'subagent_report' && event.toolName !== 'subagent_question') {
    return undefined;
  }

  const assistant = context.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');

  if (!callsReportAlone(assistant)) {
    return { block: true, reason: `Call ${event.toolName} alone after all other tools finish.` };
  }

  return undefined;
};

const registerQuestionTool = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.registerTool({
    name: 'subagent_question',
    label: 'Ask parent',
    description:
      'Ask the parent one clarification and pause this turn without exiting. Waiting uses the original deadline. This does not authorize increased scope. Call alone.',
    parameters: Type.Object(
      { question: Type.String({ minLength: 1, maxLength: 32000 }) },
      { additionalProperties: false },
    ),
    execute(...argumentsList) {
      return askParent(state, argumentsList[1].question, argumentsList[4]);
    },
  });
};

const registerReportTool = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.registerTool({
    name: 'subagent_report',
    label: 'Worker report',
    description:
      'Submit the final durable handover once. Receipt does not prove correctness or stopped work. Do not retry uncertain delivery.',
    parameters: reportParameters,
    execute(...argumentsList) {
      return reportToParent(state, argumentsList[1], pi);
    },
  });
};

const registerInputHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('input', (event, context) => handleInput(state, event, context));
};

const registerToolCallHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('tool_call', (event, context) => handleToolCall(state, event, context));
};

const registerSessionStartHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('session_start', (_event, context) => startWorker(pi, state, context));
};

const registerSessionShutdownHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('session_shutdown', () => {
    state.removeNotificationListener?.();
    clearInterval(state.kickoff);
    clearInterval(state.parentWatch);
  });
};

const registerAgentStartHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('agent_start', () => {
    if (!state.task || state.accepted) {
      return;
    }

    recordEvent(state.directory, state.task.taskId, 'accepted', 'Pi started the assigned task.');
    state.accepted = true;
  });
};

const registerAgentSettledHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('agent_settled', (_event, context) => {
    if (!hasRunningTask(state) || state.pendingQuestion) {
      return;
    }

    const task = state.task;

    if (readChildren(pi).active > 0) {
      return;
    }

    state.settled = true;
    recordEvent(state.directory, task.taskId, 'settled', {
      detail: 'Pi has no active run or queued continuation.',
      stopped: true,
    });
    context.shutdown();
  });
};

export default function workerExtension(pi: ExtensionAPI): void {
  // oxlint-disable-next-line node/no-process-env -- The parent binds this process to its saved task through the pane environment.
  const directory = process.env.TAU_WORKER_RECORD;

  if (!directory) {
    return;
  }

  const state: WorkerState = {
    directory,
    task: undefined,
    accepted: false,
    reported: false,
    settled: false,
    kickoff: undefined,
    pendingQuestion: undefined,
    parentWatch: undefined,
    removeNotificationListener: undefined,
  };

  state.removeNotificationListener = pi.events.on('tau:child-notification', (value: unknown) => {
    handleChildNotification(pi, state, value);
  });

  registerQuestionTool(pi, state);
  registerInputHandler(pi, state);
  registerReportTool(pi, state);
  registerSessionStartHandler(pi, state);
  registerSessionShutdownHandler(pi, state);
  registerAgentStartHandler(pi, state);
  registerToolCallHandler(pi, state);
  registerAgentSettledHandler(pi, state);
}
