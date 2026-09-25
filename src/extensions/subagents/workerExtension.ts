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

import { parsePhaseDescription, writeWorkerActivity } from './activity.js';
import type { WorkerActivity } from './activity.js';
import { monotonicNow } from './controller/budget.js';
import { checkWorkerRuntime } from './loadout.js';
import { workerPrompt } from './profiles.js';
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
import type { Question, Report, Task } from './types.js';

type WorkerPhase = 'starting' | 'active' | 'waiting' | 'done';

interface WorkerExtensionState {
  directory: string;
  task: Task | undefined;
  accepted: boolean;
  reported: boolean;
  incompleteRefused: boolean;
  remindAfterRefusal: boolean;
  settled: boolean;
  kickoff: ReturnType<typeof setInterval> | undefined;
  pendingQuestion: Question | undefined;
  parentWatch: ReturnType<typeof setInterval> | undefined;
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
      description:
        'Required for incomplete: the external dependency, exhausted limit, or parent decision that stops you.',
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

const startParentWatch = (
  state: WorkerExtensionState,
  task: Task,
  context: ExtensionContext,
): void => {
  // A restarted parent can reply until the deadline unless the previous parent closed cleanly.
  // Start watching before publication so an uncertain save still ends the wait.
  state.parentWatch = setInterval(() => {
    if (!shouldEndParentWait(state, task)) {
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
  startParentWatch(state, task, context);
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
  state: WorkerExtensionState,
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

const remainingWork = (task: Task): number =>
  task.monotonicDeadline - task.cancellationBudget - monotonicNow();

// Refuse once so an early handback costs a named blocker, but never so late that the report is lost.
const refuseEarlyIncomplete = (
  state: WorkerExtensionState,
  task: Task,
  blocker: string | undefined,
) => {
  if (blocker === undefined || blocker.trim() === '') {
    state.remindAfterRefusal = true;
    throw new Error(
      'An incomplete report needs a blocker: the external dependency, exhausted limit, or parent decision that stops you. Without one, finish the work or report failure.',
    );
  }

  const remaining = remainingWork(task);
  const window = task.deadline - task.createdAt;

  if (state.incompleteRefused || remaining < Math.max(0.2 * window, 300_000)) {
    return;
  }

  state.incompleteRefused = true;
  state.remindAfterRefusal = true;
  throw new Error(
    `Report refused: ${Math.floor(remaining / 60_000)} minutes remain. Finish the remaining assigned work. Report incomplete only when a concrete blocker stops you.`,
  );
};

const handoffSections = ['Changes', 'Evidence', 'Decisions', 'Concerns'];

// A heading starts its line, may carry Markdown marks, and ends at a colon, parenthesis, or line end.
const refuseMissingSections = (state: WorkerExtensionState, summary: string) => {
  const missing = handoffSections.filter(
    (section) => !new RegExp(`^[\\s#*>-]*${section}\\**\\s*(?::|\\(|$)`, 'im').test(summary),
  );

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
  const { blocker, ...handover } = parameters;

  // Check what will be saved: a blocker can push the last section past the size limit.
  const summary = withBlocker(
    handover.summary,
    handover.outcome === 'incomplete' ? blocker : undefined,
  );

  refuseMissingSections(state, summary);

  if (handover.outcome === 'incomplete') {
    refuseEarlyIncomplete(state, task, blocker);
  }

  const report = acceptReport(state.directory, task.taskId, {
    ...handover,
    summary,
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

const registerQuestionTool = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
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

const progressParameters = Type.Object(
  { description: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

const registerProgressTool = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.registerTool({
    name: 'subagent_progress',
    label: 'Report progress',
    description: [
      'Publish one short single-line phase description when the work phase changes, for example "Inspecting launch code" or "Running focused tests".',
      'Update it on phase changes only, not for every tool call and not for reassurance.',
      'It is passive: it never wakes the parent and never extends the deadline.',
    ].join(' '),
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
      'Submit the final durable handoff once.',
      'Put the Changes, Evidence, Decisions, and Concerns sections in summary; evidence holds references, not the Evidence section.',
      'Outcome incomplete requires blocker. Receipt does not prove correctness or stopped work. Do not retry uncertain delivery.',
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

const registerSessionShutdownHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('session_shutdown', () => {
    clearActivityTimer(state);

    clearInterval(state.kickoff);
    clearInterval(state.parentWatch);
  });
};

const registerAgentStartHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_start', (_event, context) => {
    if (!state.task || state.accepted) {
      return;
    }

    recordEvent(state.directory, state.task.taskId, 'accepted', 'Pi started the assigned task.');
    state.accepted = true;
    recordWorkerActivity(state, context, 'active', 'Pi task accepted');
  });
};

const registerReportReminder = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_end', () => {
    if (!isTaskActive(state) || state.pendingQuestion) {
      return;
    }

    const task = state.task;

    if (remainingWork(task) <= 0 || taskEnded(state.directory, task)) {
      return;
    }

    const requested = existsSync(join(state.directory, 'reportRequest.json'));
    // A refused report earns one more reminder; otherwise the worker could settle with no report.
    const alreadyReminded = requested && !state.remindAfterRefusal;

    if (alreadyReminded) {
      return;
    }

    state.remindAfterRefusal = false;

    if (!requested) {
      publish(state.directory, 'reportRequest.json', { taskId: task.taskId, at: Date.now() });
    }

    pi.sendMessage(
      {
        customType: 'tau-worker-report-request',
        content: [
          'Your turn ended without subagent_report. Finish the assigned work, then call subagent_report.',
          'Report incomplete only with a concrete blocker. Do not expand the original scope; the deadline is unchanged.',
        ].join(' '),
        display: true,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  });
};

const registerAgentSettledHandler = (pi: ExtensionAPI, state: WorkerExtensionState): void => {
  pi.on('agent_settled', (_event, context) => {
    if (!hasRunningTask(state) || state.pendingQuestion) {
      return;
    }

    const task = state.task;

    state.settled = true;

    recordEvent(state.directory, task.taskId, 'settled', {
      detail: 'Pi has no active run or queued continuation.',
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
    accepted: false,
    reported: false,
    incompleteRefused: false,
    remindAfterRefusal: false,
    settled: false,
    kickoff: undefined,
    pendingQuestion: undefined,
    parentWatch: undefined,
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
  registerActivityHandlers(pi, state);
  registerSessionShutdownHandler(pi, state);
  registerAgentStartHandler(pi, state);
  registerToolCallHandler(pi, state);
  registerReportReminder(pi, state);
  registerAgentSettledHandler(pi, state);
}
