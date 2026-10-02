import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import type {
  AgentEndEvent,
  AgentToolResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { instructionSetNames, readInstructionSet } from '../../instructionSets.js';
import { appendSystemPrompt } from '../../systemPrompt.js';
import { parsePhaseDescription, writeWorkerActivity } from './activity.js';
import type { WorkerActivity } from './activity.js';
import { monotonicNow } from './controller/budget.js';
import { blockerKinds, decideIncompleteReport, timeBlockerReserve } from './incompleteReport.js';
import { checkWorkerRuntime } from './loadout.js';
import { handoffSections } from './presentation.js';
import { workerInstructions, workerPrompt } from './profiles.js';
import {
  acceptAcknowledgement,
  acceptQuestion,
  readReply,
  validateQuestion,
} from './questionRecords.js';
import {
  acceptReport,
  publish,
  readEvent,
  readRecord,
  readTask,
  recordEvent,
  taskEnded,
} from './records.js';
import { textLimit } from './types.js';
import type { Acknowledgement, Loadout, Question, Report, Task } from './types.js';

type WorkerPhase = 'starting' | 'active' | 'waiting' | 'done';

interface WorkerExtensionState {
  directory: string;
  task: Task | undefined;
  monotonicDeadline: number;
  accepted: boolean;
  reported: boolean;
  incompleteRefused: boolean;
  remindAfterRefusal: boolean;
  settled: boolean;
  runError: string | undefined;
  deadlineWarning: ReturnType<typeof setTimeout> | undefined;
  kickoff: ReturnType<typeof setInterval> | undefined;
  pendingQuestion: Question | undefined;
  parentWatch: ReturnType<typeof setInterval> | undefined;
  questionSettled: boolean;
  replyDelivery: { text: string; acknowledgement: Acknowledgement } | undefined;
  activitySequence: number;
  activityTimer: ReturnType<typeof setTimeout> | undefined;
  phase: WorkerPhase;
  phaseLabel: string | undefined;
  phaseDescription: { text: string; at: number } | undefined;
  usageBaseline:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined;
}

const reportParameters = Type.Object({
  outcome: StringEnum(['success', 'failure', 'incomplete']),
  summary: Type.String({ minLength: 1, maxLength: 32_000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 32_000 }), { maxItems: 100 }),
  blocker: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 4000,
      description: 'Required for incomplete: what stops you.',
    }),
  ),
  blockerKind: Type.Optional(
    StringEnum(blockerKinds, {
      description:
        'Required for incomplete. time: the deadline is nearly reached; dependency: an external dependency; decision: a parent decision; limit: another exhausted limit.',
    }),
  ),
});

type ReportInput = Static<typeof reportParameters>;

const readPiSessionUsage = (
  context: ExtensionContext,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let hasUsage = false;

  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') {
      continue;
    }

    const messageUsage = entry.message.usage;

    usage.input += messageUsage.input;
    usage.output += messageUsage.output;
    usage.cacheRead += messageUsage.cacheRead;
    usage.cacheWrite += messageUsage.cacheWrite;
    hasUsage = true;
  }

  return hasUsage ? usage : undefined;
};

const taskUsage = (
  current: ReturnType<typeof readPiSessionUsage>,
  baseline: WorkerExtensionState['usageBaseline'],
): WorkerActivity['usage'] => {
  if (!current) {
    return undefined;
  }

  const start = baseline ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  return {
    input: Math.max(0, current.input - start.input),
    output: Math.max(0, current.output - start.output),
    cacheRead: Math.max(0, current.cacheRead - start.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - start.cacheWrite),
  };
};

const clearActivityTimer = (state: WorkerExtensionState): void => {
  clearTimeout(state.activityTimer);

  state.activityTimer = undefined;
};

const recordWorkerActivity = (
  state: WorkerExtensionState,
  context: ExtensionContext,
  phase: WorkerPhase,
  label?: string,
): void => {
  clearActivityTimer(state);

  if (!state.task) {
    return;
  }

  if (state.settled && phase !== 'done') {
    return;
  }

  try {
    const usage = taskUsage(readPiSessionUsage(context), state.usageBaseline);

    state.activitySequence += 1;
    state.phase = phase;
    state.phaseLabel = label;

    writeWorkerActivity(state.directory, {
      taskId: state.task.taskId,
      sequence: state.activitySequence,
      updatedAt: Date.now(),
      phase,
      ...(label != null && label !== '' ? { label } : {}),
      ...(state.phaseDescription
        ? {
            description: state.phaseDescription.text,
            descriptionAt: state.phaseDescription.at,
          }
        : {}),
      ...(context.model ? { model: `${context.model.provider}/${context.model.id}` } : {}),
      ...(usage ? { usage } : {}),
    });
  } catch {
    // Activity is optional UI evidence and cannot affect worker execution.
  }
};

const hasRunningTask = (
  state: WorkerExtensionState,
): state is WorkerExtensionState & { task: Task } =>
  state.task !== undefined && state.accepted && !state.settled;

const isTaskActive = (
  state: WorkerExtensionState,
): state is WorkerExtensionState & { task: Task } => hasRunningTask(state) && !state.reported;

// A worker-authored phase keeps its own timestamp and does not change lifecycle truth or the
// automatic activity label, so unrelated Pi events cannot make an old phase look freshly reported.
const recordPhaseDescription = (
  state: WorkerExtensionState,
  context: ExtensionContext,
  value: string,
): { description: string; descriptionAt: number } => {
  if (!isTaskActive(state)) {
    throw new Error('This worker has no accepted active task for progress.');
  }

  const text = parsePhaseDescription(value);
  const at = Date.now();

  state.phaseDescription = { text, at };
  recordWorkerActivity(state, context, state.phase, state.phaseLabel);

  return { description: text, descriptionAt: at };
};

const matchesNativeSession = (task: Task, context: ExtensionContext): boolean =>
  context.sessionManager.getSessionId() === task.nativeSessionId &&
  context.sessionManager.getSessionFile() === task.nativeSessionFile;

const shouldEndParentWait = (state: WorkerExtensionState, task: Task): boolean => {
  if (!state.pendingQuestion || state.settled) {
    return false;
  }

  return (
    Date.now() >= task.deadline || Boolean(readEvent(state.directory, task.taskId, 'parentClosed'))
  );
};

// The parent saves the reply as a record; send it to this session as a user message. Wait until the
// question turn settled, or its settle handler would see no pending question and end the task. Pi
// can drop the message before the input hook, so the hook saves the acknowledgement.
const deliverSavedReply = (
  pi: ExtensionAPI,
  state: WorkerExtensionState,
  task: Task,
  context: ExtensionContext,
): void => {
  const question = state.pendingQuestion;
  const readyForReply = state.questionSettled && state.replyDelivery === undefined;

  if (!question || !readyForReply || !matchesNativeSession(task, context)) {
    return;
  }

  const reply = readReply(state.directory, task.taskId, question.questionId);

  if (!reply) {
    return;
  }

  const text = `Parent clarification for the original task only. Scope, safety settings and deadline are unchanged.\n\n${reply.reply}`;

  state.replyDelivery = {
    text,
    acknowledgement: {
      version: 1,
      taskId: task.taskId,
      questionId: question.questionId,
      replyId: reply.replyId,
    },
  };

  try {
    pi.sendUserMessage(text, { deliverAs: 'followUp' });
  } catch (error) {
    state.replyDelivery = undefined;
    throw error;
  }
};

const startParentWatch = (
  pi: ExtensionAPI,
  state: WorkerExtensionState,
  task: Task,
  context: ExtensionContext,
): void => {
  let refusal: string | undefined;

  // A restarted parent can reply until the deadline unless the previous parent closed cleanly.
  // Start watching before publication so an uncertain save still ends the wait.
  state.parentWatch = setInterval(() => {
    if (!shouldEndParentWait(state, task)) {
      try {
        deliverSavedReply(pi, state, task, context);
      } catch (error) {
        // An unreadable reply stays unacknowledged; report it once, not on every tick.
        if (refusal !== String(error)) {
          refusal = String(error);
          context.ui.notify(`Reply refused: ${refusal}. No automatic retry.`, 'error');
        }
      }

      return;
    }

    clearInterval(state.parentWatch);
    state.settled = true;

    try {
      recordEvent(state.directory, task.taskId, 'settled', {
        detail: 'Parent closed or task deadline passed while this worker waited for a reply.',
        stopped: true,
      });
    } finally {
      context.shutdown();
    }
  }, 1000);
};

const askParent = (
  pi: ExtensionAPI,
  state: WorkerExtensionState,
  questionText: string,
  context: ExtensionContext,
): Promise<AgentToolResult<Question>> => {
  if (!isTaskActive(state) || state.pendingQuestion) {
    throw new Error('This worker has no active task available for a question.');
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
  recordWorkerActivity(state, context, 'waiting', 'Waiting for parent question reply');
  startParentWatch(pi, state, task, context);
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

// Workers take no pane input. Only the dispatch before acceptance and a delivered reply pass.
const handleInput = (
  state: WorkerExtensionState,
  event: InputEvent,
  context: ExtensionContext,
): InputEventResult => {
  if (event.source !== 'extension') {
    return { action: 'handled' };
  }

  if (!state.accepted) {
    return { action: 'continue' };
  }

  const delivery = state.replyDelivery;

  if (!hasRunningTask(state) || delivery === undefined || event.text !== delivery.text) {
    return { action: 'handled' };
  }

  // A failed save keeps the question pending and unacknowledged until the wait ends.
  try {
    acceptAcknowledgement(state.directory, state.task.taskId, delivery.acknowledgement);
  } catch (error) {
    context.ui.notify(`Reply refused: ${String(error)}. No automatic retry.`, 'error');

    return { action: 'handled' };
  }

  state.replyDelivery = undefined;
  state.pendingQuestion = undefined;
  state.questionSettled = false;
  clearInterval(state.parentWatch);

  return { action: 'continue' };
};

const remainingWork = (state: WorkerExtensionState, task: Task): number =>
  state.monotonicDeadline - task.cancellationBudget - monotonicNow();

const refuseEarlyIncomplete = (
  state: WorkerExtensionState,
  task: Task,
  { blocker, blockerKind }: Pick<ReportInput, 'blocker' | 'blockerKind'>,
) => {
  if (blocker === undefined || blocker.trim() === '' || blockerKind === undefined) {
    state.remindAfterRefusal = true;
    throw new Error(
      'An incomplete report needs a blocker and blockerKind: the external dependency, exhausted limit, or parent decision that stops you. Without one, finish the work or report failure.',
    );
  }

  const remaining = remainingWork(state, task);

  const step = decideIncompleteReport({
    blockerKind,
    remaining,
    window: task.deadline - task.createdAt,
    refusedBefore: state.incompleteRefused,
  });

  if (step === 'accept') {
    return;
  }

  if (step === 'refuseTime') {
    state.remindAfterRefusal = true;
    throw new Error(
      `Report refused: ${Math.floor(remaining / 1000)} seconds remain. Continue the remaining assigned work now. Do not sleep, poll, or retry the report only to wait out the time. Report incomplete only when a concrete blocker stops you.`,
    );
  }

  state.incompleteRefused = true;
  state.remindAfterRefusal = true;
  throw new Error(
    `Report refused: ${Math.floor(remaining / 60_000)} minutes remain. Finish the remaining assigned work. Report incomplete only when a concrete blocker stops you.`,
  );
};

const refuseMissingSections = (state: WorkerExtensionState, summary: string) => {
  const missing = handoffSections({ summary })?.missing ?? [];

  if (missing.length === 0) {
    return;
  }

  state.remindAfterRefusal = true;
  throw new Error(
    `Report refused: summary is missing the ${missing.join(', ')} section headings. Resend a compact summary with all four sections, writing None under any that is empty.`,
  );
};

// Concerns come last and matter most, so trim the blocker first and cut the summary only to fit a short one.
const withBlocker = (summary: string, blocker: string | undefined): string => {
  if (blocker === undefined) {
    return summary;
  }

  const room = Math.max(200, textLimit - summary.length - 'Blocker: \n\n'.length);

  return `Blocker: ${blocker.slice(0, room)}\n\n${summary}`.slice(0, textLimit);
};

const reportToParent = (
  state: WorkerExtensionState,
  parameters: ReportInput,
): Promise<AgentToolResult<Report>> => {
  if (!isTaskActive(state)) {
    throw new Error('This worker has no accepted active task.');
  }

  const task = state.task;
  const { blocker, blockerKind: _blockerKind, ...handover } = parameters;

  // Check what will be saved: a blocker can push the last section past the size limit.
  const summary = withBlocker(
    handover.summary,
    handover.outcome === 'incomplete' ? blocker : undefined,
  );

  refuseMissingSections(state, summary);

  if (handover.outcome === 'incomplete') {
    refuseEarlyIncomplete(state, task, parameters);
  }

  const report = acceptReport(state.directory, task.taskId, {
    ...handover,
    summary,
    taskId: task.taskId,
  });

  state.reported = true;
  clearTimeout(state.deadlineWarning);

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
  state: WorkerExtensionState,
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

const refuseAcceptedTask = (
  state: WorkerExtensionState,
  task: Task,
  context: ExtensionContext,
): void => {
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

const startWorker = (
  pi: ExtensionAPI,
  state: WorkerExtensionState,
  context: ExtensionContext,
): void => {
  try {
    const task = readTask(state.directory);

    state.task = task;
    // Bun's hrtime starts at process launch, so the parent's saved monotonicDeadline is on another clock.
    // Anchor the shared wall-clock deadline once, then measure locally.
    state.monotonicDeadline = monotonicNow() + task.deadline - Date.now();
    state.usageBaseline = readPiSessionUsage(context);
    state.phaseDescription = undefined;
    recordWorkerActivity(state, context, 'starting', 'Pi worker starting');

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

    // The parent enforces active work deadlines; the reply wait uses the saved wall-clock deadline.
    checkWorkerRuntime(task.loadout, pi, context);

    recordEvent(state.directory, task.taskId, 'ready', {
      detail: 'Saved model, cwd, and CC Safety Net checked.',
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
  state: WorkerExtensionState,
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

  // A profile may list this tool, but a worker pane has no user to answer it.
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

const registerQuestionTool = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.registerTool({
    name: 'subagent_question',
    label: 'Ask parent',
    description:
      'Ask the parent one question and wait for the reply. The deadline keeps running, and the reply cannot widen scope. Call alone.',
    parameters: Type.Object(
      { question: Type.String({ minLength: 1, maxLength: 32000 }) },
      { additionalProperties: false },
    ),
    execute(...argumentsList) {
      return askParent(pi, state, argumentsList[1].question, argumentsList[4]);
    },
  });
};

const progressParameters = Type.Object(
  { description: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

const registerProgressTool = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.registerTool({
    name: 'subagent_progress',
    label: 'Report progress',
    description:
      'Publish a short one-line phase, such as "Running focused tests", only when the work phase changes. It never wakes the parent or extends the deadline.',
    parameters: progressParameters,
    execute(...argumentsList) {
      const saved = recordPhaseDescription(state, argumentsList[4], argumentsList[1].description);

      return Promise.resolve({
        content: [{ type: 'text' as const, text: 'Progress saved for the parent widget.' }],
        details: saved,
      });
    },
  });
};

const registerReportTool = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.registerTool({
    name: 'subagent_report',
    label: 'Worker report',
    description: [
      'Submit the final report once. Put the report sections in summary; evidence holds references, not the Evidence section.',
      'Do not retry uncertain delivery.',
    ].join(' '),
    parameters: reportParameters,
    execute(...argumentsList) {
      return reportToParent(state, argumentsList[1]);
    },
  });
};

const registerInputHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('input', (event, context) => handleInput(state, event, context));
};

const registerToolCallHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('tool_call', (event, context) => handleToolCall(state, event, context));
};

const registerSessionStartHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('session_start', (_event, context) => {
    startWorker(pi, state, context);
  });
};

const registerActivityHandlers = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('turn_start', (_event, context) => {
    recordWorkerActivity(state, context, 'active', 'Pi is thinking');
  });

  pi.on('turn_end', (_event, context) => {
    recordWorkerActivity(state, context, 'waiting', 'Pi is between turns');
  });

  pi.on('message_update', (_event, context) => {
    if (state.activityTimer) {
      return;
    }

    state.activityTimer = setTimeout(() => {
      state.activityTimer = undefined;
      recordWorkerActivity(state, context, 'active', 'Pi response streaming');
    }, 500);
  });

  pi.on('tool_execution_start', (event, context) => {
    recordWorkerActivity(state, context, 'active', `tool: ${event.toolName}`);
  });

  pi.on('tool_execution_end', (event, context) => {
    recordWorkerActivity(state, context, 'active', `tool finished: ${event.toolName}`);
  });
};

// The worker pane is bound to its saved native session, so /new, /resume, and /fork would orphan the task.
const registerSessionSwitchBlock = (pi: ExtensionAPI): void => {
  pi.on('session_before_switch', () => ({ cancel: true }));
  pi.on('session_before_fork', () => ({ cancel: true }));
};

const registerSessionShutdownHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('session_shutdown', () => {
    clearActivityTimer(state);

    clearInterval(state.kickoff);
    clearInterval(state.parentWatch);
    clearTimeout(state.deadlineWarning);
  });
};

const readLoadoutInstructionSets = (loadout: Loadout): Promise<string[]> =>
  Promise.all(
    instructionSetNames
      .filter((name) => loadout.instructionSets.includes(name))
      .map((name) => readInstructionSet(name)),
  );

const registerSystemPromptHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  // Read once, so every turn gets the same text even if the checkout changes.
  let instructionSets: Promise<string[]> | undefined;

  pi.on('before_agent_start', async (event) => {
    if (state.task) {
      instructionSets ??= readLoadoutInstructionSets(state.task.loadout);
      appendSystemPrompt(event, workerInstructions(state.task.loadout));

      for (const text of await instructionSets) {
        appendSystemPrompt(event, text);
      }
    }
  });
};

const armDeadlineWarning = (pi: ExtensionAPI, state: WorkerExtensionState, task: Task): void => {
  state.deadlineWarning = setTimeout(
    () => {
      if (!isTaskActive(state) || state.pendingQuestion) {
        return;
      }

      const seconds = Math.max(0, Math.floor(remainingWork(state, task) / 1000));

      pi.sendMessage(
        {
          customType: 'tau-worker-deadline',
          content: `Deadline in ${seconds} s: call subagent_report now with what you have; blockerKind time is accepted.`,
          display: true,
        },
        { deliverAs: 'steer', triggerTurn: true },
      );
    },
    Math.max(0, remainingWork(state, task) - timeBlockerReserve),
  );
};

const lastRunError = (event: AgentEndEvent): string | undefined => {
  const message = event.messages.findLast((entry) => entry.role === 'assistant');

  if (message?.role !== 'assistant') {
    return undefined;
  }

  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
    return undefined;
  }

  return `Pi run ended with ${message.stopReason}: ${message.errorMessage ?? 'no error message'}`;
};

const registerAgentStartHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_start', (_event, context) => {
    if (!state.task || state.accepted) {
      return;
    }

    recordEvent(state.directory, state.task.taskId, 'accepted', 'Pi started the assigned task.');
    state.accepted = true;
    recordWorkerActivity(state, context, 'active', 'Pi task accepted');
    armDeadlineWarning(pi, state, state.task);
  });
};

const registerRunErrorHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_end', (event) => {
    state.runError = lastRunError(event);
  });
};

const reportReminder: CustomMessageEntryDraft = {
  type: 'custom_message',
  customType: 'tau-worker-report-request',
  content: [
    'Your turn ended without subagent_report. Finish the assigned work, then call subagent_report.',
    'Report incomplete only with a concrete blocker. Do not expand the original scope; the deadline is unchanged.',
  ].join(' '),
  display: true,
};

const registerReportReminder = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_before_settle', (event) => {
    // A reminder after an errored or aborted run repeats the same error; the error explains the stop.
    if (!isTaskActive(state) || state.pendingQuestion || state.runError !== undefined) {
      return undefined;
    }

    const task = state.task;

    if (remainingWork(state, task) <= 0 || taskEnded(state.directory, task)) {
      return undefined;
    }

    const requested = existsSync(join(state.directory, 'reportRequest.json'));
    // A refused report earns one more reminder; otherwise the worker could settle with no report.
    const alreadyReminded = requested && !state.remindAfterRefusal;

    if (alreadyReminded) {
      return undefined;
    }

    state.remindAfterRefusal = false;

    if (!requested) {
      publish(state.directory, 'reportRequest.json', { taskId: task.taskId, at: Date.now() });
    }

    return { entries: [...event.entries, reportReminder], continue: true };
  });
};

const registerAgentSettledHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_settled', (_event, context) => {
    if (!hasRunningTask(state)) {
      return;
    }

    if (state.pendingQuestion) {
      state.questionSettled = true;

      return;
    }

    const task = state.task;

    state.settled = true;

    recordEvent(state.directory, task.taskId, 'settled', {
      detail: state.runError ?? 'Pi has no active run or queued continuation.',
      stopped: true,
    });

    recordWorkerActivity(state, context, 'done', 'Pi run settled');
    context.shutdown();
  });
};

export default function workerExtension(pi: ExtensionAPI): void {
  // oxlint-disable-next-line node/no-process-env -- The parent binds this process to its saved task through the pane environment.
  const directory = process.env.TAU_WORKER_RECORD;

  if (directory == null || directory === '') {
    return;
  }

  const state: WorkerExtensionState = {
    directory,
    task: undefined,
    monotonicDeadline: 0,
    accepted: false,
    reported: false,
    incompleteRefused: false,
    remindAfterRefusal: false,
    settled: false,
    runError: undefined,
    deadlineWarning: undefined,
    kickoff: undefined,
    pendingQuestion: undefined,
    parentWatch: undefined,
    questionSettled: false,
    replyDelivery: undefined,
    activitySequence: 0,
    activityTimer: undefined,
    phase: 'starting',
    phaseLabel: undefined,
    phaseDescription: undefined,
    usageBaseline: undefined,
  };

  registerQuestionTool(pi, state);
  registerInputHandler(pi, state);
  registerProgressTool(pi, state);
  registerReportTool(pi, state);
  registerSessionStartHandler(pi, state);
  registerSessionSwitchBlock(pi);
  registerActivityHandlers(pi, state);
  registerSessionShutdownHandler(pi, state);
  registerSystemPromptHandler(pi, state);
  registerAgentStartHandler(pi, state);
  registerToolCallHandler(pi, state);
  registerRunErrorHandler(pi, state);
  registerReportReminder(pi, state);
  registerAgentSettledHandler(pi, state);
}
