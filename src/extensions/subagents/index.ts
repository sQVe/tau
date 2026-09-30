/* oxlint-disable node/no-process-env -- The herdr connection comes from the active Pi process. */

import { StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { appendToolGuidelines } from '../../systemPrompt/index.js';
import { isWorkerProcess } from '../../workerProcess/index.js';
import { WorkerController } from './controller/controller.js';
import { EvidenceUnavailableError } from './controller/record.js';
import { historyPage, searchHistory } from './history.js';
import { readSessionLedger } from './ledgerRecords.js';
import { resolveLoadout } from './loadout.js';
import { modelEvidenceNotice, modelReply, modelStatus } from './presentation.js';
import type { WorkerNotice } from './presentation.js';
import { listProfiles } from './profiles.js';
import type { ProfileSummary } from './profiles.js';
import { workerRecordsDirectory } from './records.js';
import {
  callText,
  firstLine,
  renderHistoryResult,
  renderNotice,
  renderReplyResult,
  renderStatusResult,
  shortId,
} from './render.js';
import { taskIdSchema } from './types.js';
import { renderWorkerWidget } from './widget.js';
import type { WorkerWidgetRow } from './widget.js';
import { openWorkerHistory } from './widgetOverlay.js';
import type { WorkerHistoryView } from './widgetOverlay.js';

interface SubagentRuntime {
  pi: ExtensionAPI;
  getController: () => WorkerController;
  peekController: () => WorkerController | undefined;
}

type NoticeDelivery = (
  context: Pick<ExtensionContext, 'isIdle'> | undefined,
  notice: WorkerNotice,
) => void;

const visibility = Type.Optional(
  StringEnum(['foreground', 'background'] as const, {
    description:
      'Foreground opens beside the parent, background in a separate tab. Defaults to foreground for editing profiles. The result reports the actual placement.',
  }),
);

const launchParameters = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 32_000 }),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: 'Short widget label, such as "Fix status counts".',
      }),
    ),
    profile: Type.String({ minLength: 1 }),
    cwd: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    visibility,
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 10,
        maximum: 86_400,
        description: 'Defaults to 1800 for investigation profiles and 3600 for editing profiles.',
      }),
    ),
  },
  { additionalProperties: false },
);

const defaultTimeoutSeconds = { investigation: 1800, editing: 3600 };

const followUpParameters = Type.Object(
  {
    sourceTaskId: taskIdSchema,
    task: Type.String({ minLength: 1, maxLength: 32000 }),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: 'Short widget label.',
      }),
    ),
    timeoutSeconds: Type.Integer({ minimum: 10, maximum: 86400 }),
    visibility,
  },
  { additionalProperties: false },
);

const historyParameters = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});

const statusParameters = Type.Object(
  { taskId: Type.String(), questionId: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

const replyParameters = Type.Object(
  {
    taskId: Type.String(),
    questionId: Type.String({ minLength: 1 }),
    replyId: Type.String({ pattern: '^[a-zA-Z0-9-]{1,128}$' }),
    reply: Type.String({ minLength: 1, maxLength: 32000 }),
  },
  { additionalProperties: false },
);

const cancelParameters = Type.Object({ taskId: Type.String() });

type LaunchParameters = Static<typeof launchParameters>;
type FollowUpParameters = Static<typeof followUpParameters>;
type HistoryParameters = Static<typeof historyParameters>;
type StatusParameters = Static<typeof statusParameters>;
type ReplyParameters = Static<typeof replyParameters>;
type CancelParameters = Static<typeof cancelParameters>;

// A notice turn whose prompt fails before agent_start leaves later idle notices queued
// for the next user prompt instead of starting a turn.
export const createNoticeDelivery = (pi: ExtensionAPI): NoticeDelivery => {
  // The prompt a notice starts consumes every nextTurn message queued before its run begins.
  let turnStarting = false;

  pi.on('agent_start', () => {
    turnStarting = false;
  });

  return (context, notice) => {
    const message = {
      customType: 'tau-worker',
      content: JSON.stringify(notice.content),
      display: true,
      details: notice.details,
    };

    // An idle triggerTurn skips before_agent_start and Tau's prompt additions with it, which
    // pi-claude-bridge rejects. A user message starts the turn through that hook.
    if (context?.isIdle() === true) {
      pi.sendMessage(message, { deliverAs: 'nextTurn' });

      if (!turnStarting) {
        turnStarting = true;
        pi.sendUserMessage('A worker notice arrived.', { deliverAs: 'steer' });
      }

      return;
    }

    pi.sendMessage(message, { deliverAs: 'steer', triggerTurn: true });
  };
};

const createController = (
  deliver: NoticeDelivery,
  getContext: () => ExtensionContext | undefined,
): WorkerController =>
  new WorkerController(workerRecordsDirectory(), undefined, (notice) => {
    deliver(getContext(), notice);
  });

const hasHerdrEnvironment = (): boolean =>
  process.env.HERDR_ENV === '1' && Boolean(process.env.HERDR_SOCKET_PATH);

const hasHerdrParentPane = (): boolean =>
  hasHerdrEnvironment() && Boolean(process.env.HERDR_PANE_ID);

export const delegationGuidelines = [
  'You are the manager. You own the plan, the user conversation, acceptance criteria, integration, and commits.',
  'Do small work yourself: quick questions, small local edits, obvious rebase conflicts, worker coordination, and back-and-forth with the user. Your own small edits need checks, not a reviewer. When a task mixes a small fix with larger work, make the fix yourself and delegate the rest.',
  'Without waiting to be asked, send larger implementation or work that needs new tests to a `worker`, and open questions that need wide reading or running commands to a `scout`. Send a finished worker change to a `reviewer` before you accept or commit it. Follow any explicit user instruction about delegation.',
  "Pass a reviewer the worker's check log path and a diff hash, such as `git hash-object` of the diff, so it reuses the checks. Use one reviewer; a large or risky change gets at most two, split by area. For a refactor whose tests do not change, the reviewer confirms behavior is unchanged.",
  'Pass a brief that several workers share as a file path. Give workers on cheap models a shorter `timeoutSeconds`. Run a multi-model discussion as one round with two models, and add a round only for a disagreement that changes the decision.',
  'Send a finished change with user-visible behavior to `qa`. It expects the user to run the app from the worktree under test. Tell it where the app runs, pass its questions to the user, and give it only test-account credentials, because worker records keep them.',
  'While subagent workers run, do not edit their worktree or redo their work.',
  'Treat a worker report as a claim. Check its evidence before you tell the user the work is done.',
  'When a worker reports, act on its result without waiting for the user: fix in-scope findings, start the next step you own, ask only when that step needs a decision you cannot make, and report and stop when the work is done.',
];

const requireHerdrParent = (
  parentPane: string | undefined,
  parentSession: string | undefined,
  message: string,
): string => {
  const paneMissing = parentPane == null || parentPane === '';
  const sessionMissing = parentSession == null || parentSession === '';

  if (!hasHerdrEnvironment() || paneMissing || sessionMissing) {
    throw new Error(message);
  }

  return parentSession;
};

// Pi streams call arguments, so a renderer can run before the model finishes any field.
const callDetail = (parts: (string | undefined)[]): string | undefined => {
  const joined = parts.filter((part): part is string => Boolean(part)).join(' · ');

  return joined.length > 0 ? joined : undefined;
};

// The model reads the same unreadable-evidence shape here as in notices.
const evidenceResult = (error: unknown) => {
  if (!(error instanceof EvidenceUnavailableError)) {
    throw error;
  }

  const details = {
    taskId: error.taskId,
    ...(error.taskName === undefined ? {} : { name: error.taskName }),
    evidenceError: error.evidenceError,
    recovery: error.recovery,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelEvidenceNotice(details)) }],
    details,
  };
};

const launchWorker = async (
  runtime: SubagentRuntime,
  parameters: LaunchParameters,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => {
  signal?.throwIfAborted();
  const startedAt = { wall: Date.now(), monotonic: performance.now() };

  const parentPane = process.env.HERDR_PANE_ID;
  const session = context.sessionManager.getSessionFile();

  const parentSession = requireHerdrParent(
    parentPane,
    session,
    'Worker launch requires a saved parent Pi session inside local herdr.',
  );

  const controller = runtime.getController();
  const loadout = resolveLoadout(parameters, context, signal, runtime.pi.getCommands());

  const timeout = (parameters.timeoutSeconds ?? defaultTimeoutSeconds[loadout.role]) * 1000;

  signal?.throwIfAborted();

  let status: Awaited<ReturnType<WorkerController['launch']>>;

  try {
    status = await controller.launch(
      {
        task: parameters.task,
        ...(parameters.label === undefined ? {} : { label: parameters.label }),
        loadout,
        timeout,
        startedAt,
        parentSession,
        parentSessionId: context.sessionManager.getSessionId(),
        ...(parameters.visibility ? { visibility: parameters.visibility } : {}),
      },
      signal,
    );
  } catch (error) {
    return evidenceResult(error);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
    details: status,
  };
};

const followUpWorker = async (
  runtime: SubagentRuntime,
  parameters: FollowUpParameters,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => {
  const parentPane = process.env.HERDR_PANE_ID;
  const session = context.sessionManager.getSessionFile();

  const parentSession = requireHerdrParent(
    parentPane,
    session,
    'Follow-up requires a saved parent session inside local herdr.',
  );

  const controller = runtime.getController();

  let status: Awaited<ReturnType<WorkerController['followUp']>>;

  try {
    status = await controller.followUp(
      {
        ...parameters,
        timeout: parameters.timeoutSeconds * 1000,
        parentSession,
        parentSessionId: context.sessionManager.getSessionId(),
      },
      context,
      signal,
    );
  } catch (error) {
    return evidenceResult(error);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
    details: status,
  };
};

const searchWorkerHistory = async (
  parameters: HistoryParameters,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
  controller: WorkerController | undefined,
) => {
  signal?.throwIfAborted();
  const file = context.sessionManager.getSessionFile();

  if (file == null || file === '') {
    throw new Error('History requires a saved current session.');
  }

  const history = await searchHistory(
    workerRecordsDirectory(),
    {
      file,
      id: context.sessionManager.getSessionId(),
      sessionDirectory: context.sessionManager.getSessionDir(),
    },
    parameters.query,
    (taskId) => controller?.owns(taskId) ?? false,
  );

  signal?.throwIfAborted();

  const page = historyPage(history, parameters.offset, parameters.limit);

  return { content: [{ type: 'text' as const, text: JSON.stringify(page) }], details: page };
};

const readWorkerStatus = (
  runtime: SubagentRuntime,
  parameters: StatusParameters,
  context: ExtensionContext,
) => {
  const parentSessionId = context.sessionManager.getSessionId();
  const active = runtime.getController();

  try {
    const current = active.status(parameters.taskId, parentSessionId);

    const receipt =
      parameters.questionId != null && parameters.questionId !== ''
        ? active.questionReceipt(parameters.taskId, parentSessionId, parameters.questionId)
        : undefined;

    const status = { ...current, questionReceipt: receipt };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
      details: status,
    };
  } catch (error) {
    return evidenceResult(error);
  }
};

const replyToWorker = (
  runtime: SubagentRuntime,
  parameters: ReplyParameters,
  context: ExtensionContext,
) => {
  const receipt = runtime
    .getController()
    .reply(parameters.taskId, context.sessionManager.getSessionId(), parameters);

  const questionId = { questionId: parameters.questionId };
  const content = modelReply(parameters.taskId, { ...receipt, ...questionId });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(content) }],
    details: { taskId: parameters.taskId, ...receipt, ...questionId },
  };
};

const cancelWorker = async (
  runtime: SubagentRuntime,
  parameters: CancelParameters,
  context: ExtensionContext,
) => {
  let status: Awaited<ReturnType<WorkerController['cancel']>>;

  try {
    status = await runtime
      .getController()
      .cancel(parameters.taskId, context.sessionManager.getSessionId());
  } catch (error) {
    return evidenceResult(error);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
    details: status,
  };
};

// An unreadable profile directory also fails every launch, which reports the read error.
const launchProfiles = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
): ProfileSummary[] => {
  try {
    return listProfiles(context.cwd, getAgentDir(), context.isProjectTrusted());
  } catch {
    return [];
  }
};

const profileText = (profiles: ProfileSummary[]): string =>
  profiles.length === 0
    ? 'unreadable, launch reports why'
    : profiles
        .map(({ name, description }) =>
          description === undefined ? name : `${name} (${description})`,
        )
        .join(', ');

const registerLaunchTool = (runtime: SubagentRuntime, profiles: ProfileSummary[]): void => {
  runtime.pi.registerTool({
    name: 'subagent',
    label: 'Launch worker',
    description: [
      'Launch a Pi worker in a herdr pane. cwd must match this session.',
      `Profiles: ${profileText(profiles)}. model overrides the profile's Pi provider/id.`,
      'Give the task acceptance criteria, baseline, and worktree; one editor per worktree. The deadline includes waits and cleanup.',
      'A notice starts a new turn when a worker asks, reports, or stops. End your turn to wait; never sleep or poll.',
    ].join(' '),
    promptSnippet: 'Launch Tau workers to scout, implement, or review work',
    parameters: launchParameters,
    renderCall(parameters, theme) {
      return callText(
        'Launch worker',
        callDetail([parameters.profile, firstLine(parameters.task)]),
        theme,
      );
    },
    renderResult(result, options, theme) {
      return renderStatusResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return launchWorker(runtime, parameters, signal, context);
    },
  });
};

const registerFollowUpTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_follow_up',
    label: 'Follow up completed worker',
    description: [
      'Give a stopped worker a new task in its saved session and settings.',
      'The source must have a report, no successorTaskId, and no live session.',
    ].join(' '),
    parameters: followUpParameters,
    renderCall(parameters, theme) {
      return callText(
        'Follow up worker',
        callDetail([shortId(parameters.sourceTaskId), firstLine(parameters.task)]),
        theme,
      );
    },
    renderResult(result, options, theme) {
      return renderStatusResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return followUpWorker(runtime, parameters, signal, context);
    },
  });
};

const registerHistoryTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_history',
    label: 'Search session history',
    description: [
      'Search earlier workers in this session history by name, task or session ID, or description.',
      'Page with nextOffset and the same query. truncatedFields marks previews; use full IDs, and reportFile for a truncated report.',
    ].join(' '),
    parameters: historyParameters,
    renderCall(parameters, theme) {
      return callText('Search session history', parameters.query, theme);
    },
    renderResult(result, options, theme) {
      return renderHistoryResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return searchWorkerHistory(parameters, signal, context, runtime.peekController());
    },
  });
};

const registerStatusTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_status',
    label: 'Worker status',
    description: [
      "Read a direct child task's state, saved references, and report evidence. questionId selects a reply and its acknowledgement.",
      'After a restart, the same parent session reattaches workers that herdr confirms; do not relaunch them.',
      'No state means unreadable records; inspect recovery, or cancel a worker this session owns.',
    ].join(' '),
    parameters: statusParameters,
    renderCall(parameters, theme) {
      return callText('Worker status', shortId(parameters.taskId), theme);
    },
    renderResult(result, options, theme) {
      return renderStatusResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return Promise.resolve().then(() => readWorkerStatus(runtime, parameters, context));
    },
  });
};

const registerReplyTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_reply',
    label: 'Reply to worker',
    description: [
      "Answer a worker's pending question with the questionId from its notice and a unique replyId. Resending the same reply is safe.",
      'A reply cannot widen scope or extend the deadline. After a worker stops, use subagent_follow_up.',
    ].join(' '),
    parameters: replyParameters,
    renderCall(parameters, theme) {
      return callText('Reply to worker', shortId(parameters.taskId), theme);
    },
    renderResult(result, options, theme) {
      return renderReplyResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return Promise.resolve(replyToWorker(runtime, parameters, context));
    },
  });
};

const registerCancelTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_cancel',
    label: 'Cancel worker',
    description:
      'Cancel a worker this session owns. cleanupUnconfirmed in the result needs manual cleanup.',
    parameters: cancelParameters,
    renderCall(parameters, theme) {
      return callText('Cancel worker', shortId(parameters.taskId), theme);
    },
    renderResult(result, options, theme) {
      return renderStatusResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return cancelWorker(runtime, parameters, context);
    },
  });
};

const registerSubagentTools = (runtime: SubagentRuntime): void => {
  registerLaunchTool(
    runtime,
    launchProfiles({ cwd: process.cwd(), isProjectTrusted: () => false }),
  );

  registerFollowUpTool(runtime);
  registerHistoryTool(runtime);
  registerStatusTool(runtime);
  registerReplyTool(runtime);
  registerCancelTool(runtime);
};

const activeStates = new Set(['starting', 'running', 'awaitingReply', 'reported', 'stopping']);
const unitSeconds: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

// A running tool call holds worker notices back, so a long sleep delays the notice it waits for.
// Sleep sums its operands, and chained sleeps add up, so count every operand in the command.
const totalSleepSeconds = (command: string): number => {
  let total = 0;

  for (const [, operands] of command.matchAll(/\bsleep((?:\s+\d+(?:\.\d+)?[smhd]?\b)+)/g)) {
    for (const [, amount, unit] of (operands ?? '').matchAll(/(\d+(?:\.\d+)?)([smhd]?)/g)) {
      total += Number(amount) * (unitSeconds[unit ?? ''] ?? 1);
    }
  }

  return total;
};

// Returns the worker ledger reader that compaction puts at the top of its summary.
export const registerSubagents = (pi: ExtensionAPI) => {
  if (isWorkerProcess()) {
    return undefined;
  }

  let controller: WorkerController | undefined;
  let sessionContext: ExtensionContext | undefined;
  const deliverNotice = createNoticeDelivery(pi);
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let historyView: WorkerHistoryView | undefined;
  let historyOpen = false;
  let shuttingDown = false;

  const runtime: SubagentRuntime = {
    pi,
    getController: () => {
      controller ??= createController(deliverNotice, () => sessionContext);

      return controller;
    },
    peekController: () => controller,
  };

  registerSubagentTools(runtime);
  // Launch needs herdr and a parent pane, so a manager outside herdr must not be told to delegate.
  appendToolGuidelines(pi, 'subagent', hasHerdrParentPane() ? delegationGuidelines : []);

  const refreshWidget = (context: ExtensionContext, currentRows?: WorkerWidgetRow[]): void => {
    if (shuttingDown || !context.hasUI || context.mode !== 'tui') {
      return;
    }

    const rows =
      currentRows ?? runtime.getController().widgetRows(context.sessionManager.getSessionId());

    historyView?.setRows(rows);

    if (rows.length === 0 || historyOpen) {
      context.ui.setWidget('tau-subagents', undefined);
    } else {
      context.ui.setWidget(
        'tau-subagents',
        (_tui, theme) => ({
          // eslint-disable-next-line eslint/no-empty-function -- The rows are replaced on each refresh.
          invalidate() {},
          render(width) {
            return renderWorkerWidget(rows, width, Date.now(), theme);
          },
        }),
        { placement: 'aboveEditor' },
      );
    }

    const hasActiveWorkers = rows.some((row) => activeStates.has(row.state));
    const refreshIsNeeded = hasActiveWorkers || historyOpen;

    if (refreshIsNeeded) {
      widgetTimer ??= setInterval(() => {
        refreshWidget(context);
      }, 1000);
    } else if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
  };

  pi.registerCommand('subagents', {
    description: 'Browse worker history, reports, usage, and recovery details.',
    handler: async (_arguments, context) => {
      if (!context.hasUI || context.mode !== 'tui') {
        return;
      }

      historyOpen = true;

      try {
        const rows = runtime.getController().widgetRows(context.sessionManager.getSessionId());

        refreshWidget(context, rows);

        await openWorkerHistory(context, rows, (view) => {
          historyView = view;
        });
      } finally {
        historyView = undefined;
        historyOpen = false;
        refreshWidget(context);
      }
    },
  });

  pi.on('session_start', (_event, context) => {
    shuttingDown = false;
    sessionContext = context;

    // Project profiles load only once the session's cwd and trust are known.
    registerLaunchTool(runtime, launchProfiles(context));

    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }

    void runtime
      .getController()
      .resume(context.sessionManager.getSessionId())
      .then(() => {
        refreshWidget(context);
      });

    refreshWidget(context);
  });

  pi.on('tool_result', (_event, context) => {
    refreshWidget(context);
  });

  pi.on('tool_call', (event, context) => {
    const command = event.toolName === 'bash' ? event.input.command : undefined;

    if (typeof command !== 'string' || totalSleepSeconds(command) < 30) {
      return undefined;
    }

    const rows = controller?.widgetRows(context.sessionManager.getSessionId()) ?? [];

    if (!rows.some((row) => activeStates.has(row.state))) {
      return undefined;
    }

    return {
      block: true,
      reason: [
        'A worker is active. Worker notices wait until the current tool call finishes, so a sleep delays them.',
        'End your turn to wait; a notice starts a new turn when the worker asks, reports, or stops.',
      ].join(' '),
    };
  });

  pi.registerMessageRenderer('tau-worker', (message, options, theme) =>
    renderNotice(message.details, options.expanded, theme),
  );

  pi.on('session_shutdown', async (event) => {
    shuttingDown = true;
    sessionContext = undefined;
    historyOpen = false;
    historyView?.dismiss();
    historyView = undefined;

    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }

    await controller?.stopAll(event.reason);
    controller = undefined;
  });

  const ownership = (taskId: string) => controller?.owns(taskId) ?? false;

  return {
    readWorkerLedger: (context: ExtensionContext) =>
      readSessionLedger(context, workerRecordsDirectory(), ownership),
  };
};

export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagents(pi);
}
