/* oxlint-disable node/no-process-env -- Worker ownership and herdr connection come from the active Pi process. */

import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { WorkerController } from './controller/controller.js';
import { EvidenceUnavailableError } from './controller/record.js';
import { historyPage, searchHistory } from './history.js';
import { resolveLoadout } from './loadout.js';
import { modelEvidenceNotice, modelReply, modelStatus } from './presentation.js';
import type { WorkerNotice } from './presentation.js';
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
import { renderWorkerWidget } from './widget.js';
import type { WorkerWidgetRow } from './widget.js';
import { openWorkerHistory } from './widgetOverlay.js';
import type { WorkerHistoryView } from './widgetOverlay.js';

const visibility = Type.Optional(
  StringEnum(['foreground', 'background'] as const, {
    description:
      'Foreground splits the parent pane or one of its worker panes and keeps the parent and its workers roughly equal in size. Background groups workers in separate worker tabs. Both preserve focus, manual split ratios, and unrelated panes. Use foreground when the user benefits from watching the work, such as implementation; use background for work they do not need to watch. Default: foreground; a worker gets a separate tab when the parent cannot share useful space.',
  }),
);

const launchParameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 32_000 }),
  label: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description:
        'Short human label for the compact widget, such as "Fix status counts". Keep the full assignment in task.',
    }),
  ),
  profile: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  harness: Type.Optional(Type.String()),
  nativeArguments: Type.Optional(
    Type.Array(Type.String({ maxLength: 8000, pattern: '^[^\\u0000]*$' }), { maxItems: 100 }),
  ),
  visibility,
  permissions: StringEnum(['trusted-full-tools', 'native-controls'] as const),
  timeoutSeconds: Type.Integer({ minimum: 10, maximum: 86_400 }),
});

const followUpParameters = Type.Object(
  {
    sourceTaskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
    task: Type.String({ minLength: 1, maxLength: 32000 }),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: 'Short human label for the compact widget. Keep the full assignment in task.',
      }),
    ),
    timeoutSeconds: Type.Integer({ minimum: 10, maximum: 86400 }),
    settingsUnchanged: Type.Literal(true),
    visibility,
  },
  { additionalProperties: false },
);

const historyParameters = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});

const statusParameters = Type.Object({
  taskId: Type.String(),
  questionId: Type.Optional(Type.String()),
  submissionId: Type.Optional(Type.String()),
  readOutput: Type.Optional(Type.Boolean()),
});

const replyParameters = Type.Object(
  {
    taskId: Type.String(),
    questionId: Type.Optional(Type.String()),
    replyId: Type.String({ pattern: '^[a-zA-Z0-9-]{1,128}$' }),
    reply: Type.String({ minLength: 1, maxLength: 32000 }),
    scopeUnchanged: Type.Boolean(),
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

interface SubagentRuntime {
  pi: ExtensionAPI;
  getController: () => WorkerController;
  peekController: () => WorkerController | undefined;
}

export const deliverWorkerNotice = (pi: ExtensionAPI, notice: WorkerNotice): void => {
  const message = JSON.stringify(notice.content);

  pi.sendMessage(
    { customType: 'tau-worker', content: message, display: true, details: notice.details },
    { deliverAs: 'steer', triggerTurn: true },
  );
};

const createController = (pi: ExtensionAPI): WorkerController =>
  new WorkerController(workerRecordsDirectory(), undefined, (notice) => {
    deliverWorkerNotice(pi, notice);
  });

const hasHerdrEnvironment = (): boolean =>
  process.env.HERDR_ENV === '1' && Boolean(process.env.HERDR_SOCKET_PATH);

const requireHerdrParent = (
  parentPane: string | undefined,
  parentSession: string | undefined,
  message: string,
): string => {
  if (!hasHerdrEnvironment() || !parentPane || !parentSession) {
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
  const timeout = parameters.timeoutSeconds * 1000;
  const workBudget = timeout - Math.min(5000, Math.floor(timeout / 4));
  const resolutionSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(workBudget),
  ]);
  const parentPane = process.env.HERDR_PANE_ID;
  const session = context.sessionManager.getSessionFile();
  const parentSession = requireHerdrParent(
    parentPane,
    session,
    'Worker launch requires a saved parent Pi session inside local herdr.',
  );

  const controller = runtime.getController();
  const loadout = resolveLoadout(parameters, context, resolutionSignal);
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

  if (!file) {
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

const readWorkerStatus = async (
  runtime: SubagentRuntime,
  parameters: StatusParameters,
  context: ExtensionContext,
) => {
  const parentSessionId = context.sessionManager.getSessionId();
  const active = runtime.getController();

  try {
    const receipt = parameters.questionId
      ? active.questionReceipt(parameters.taskId, parentSessionId, parameters.questionId)
      : undefined;
    const status = {
      ...active.status(parameters.taskId, parentSessionId),
      questionReceipt: receipt,
      submissionReceipt: parameters.submissionId
        ? active.submissionReceipt(parameters.taskId, parentSessionId, parameters.submissionId)
        : undefined,
      nativeOutput: parameters.readOutput
        ? await active.nativeOutput(parameters.taskId, parentSessionId)
        : undefined,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
      details: status,
    };
  } catch (error) {
    return evidenceResult(error);
  }
};

const replyToWorker = async (
  runtime: SubagentRuntime,
  parameters: ReplyParameters,
  context: ExtensionContext,
) => {
  const receipt = await runtime
    .getController()
    .reply(parameters.taskId, context.sessionManager.getSessionId(), parameters);

  const questionId =
    parameters.questionId === undefined ? {} : { questionId: parameters.questionId };
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

const registerLaunchTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent',
    label: 'Launch worker',
    description:
      'Launch a bounded worker in herdr. Pi (default) requires trusted-full-tools and verified CC Safety Net; its model must be explicit or configured. Other herdr kinds use native-controls, which Tau does not certify. Their nativeArguments are a literal list, and they report to cwd/.tau/workers/<taskId>/report.md, so cwd must be writable. No native arguments by default; the harness selects its configured model. An exact native model request requires corresponding nativeArguments, but Tau cannot verify the model used. Native approval dialogs remain in force and need user action. Tau adds no bypass flags and never approves dialogs. Model translation and native resume are unavailable for non-Pi workers. Workers cannot launch workers; ask the parent instead. Reports are required from the start; assign the complete outcome with acceptance criteria, the baseline, and the worktree, give each worktree one editing worker, and expect a handoff with Changes, Evidence, Decisions, and Concerns. Each parent caps its own live workers. Each worker has one original deadline, including waits and cleanup. No uncertain retries or fallback. Built-in profiles: investigator and worker. States: starting (launched, not accepted yet); running (accepted and working); awaitingReply (waiting for a parent reply); reported (final report saved, cleanup pending); stopping (bounded cleanup running); stopped (cleanup confirmed); cleanupUnconfirmed (cleanup unconfirmed, capacity stays held); notOwned (no verified handle in this controller, worker may still be running). Notices are status snapshots taken when sent. A notice starts a new parent turn when a worker asks, reports, or stops, but only after the current tool call finishes. To wait for a worker, end your turn. Do not sleep or poll. A notice without a state means the parent could not read the task records; inspect recovery.',
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
    description:
      'Assign a new bounded Pi task to an exact saved task ID in the current root-session tree. Eligible only when state is stopped, a report exists, and no successorTaskId. Reuses the exact Pi session and unchanged settings. Non-Pi continuation refuses; start a fresh task. One active successor claim per task. Confirmed cleanup before dispatch, acceptance, or a report releases the claim for retry. No uncertain retry or age-based reclaim. Searching grants no live ownership.',
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
    description:
      'Read-only name, task ID, native session ID, or description search over earlier work in the current root session tree. The current conversation and its ancestor sessions are never listed as sessions. Task candidates carry their derived state. Reports are bounded previews; truncatedFields lists preview fields, which are not exact identifiers or paths, and reportFile points at the full report when it was truncated. nativeSessionFile appears only for native-only sessions or unavailable native evidence. Repeat the same query with nextOffset to page; history is recomputed per call, so concurrent additions can shift pages. totalMatches counts all matches, not just the page. Multiple matches require clarification using full IDs; never choose the newest. Does not grant reply/cancel ownership, resume work, or copy transcripts; subagent_status stays direct-parent-only.',
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
    description:
      'Recover task results and saved native references. A saved report is the worker handoff. Its reported checks are reusable evidence for the work state they name; repeat a check only for a concrete reason such as changed inputs, a suspected defect, an integration change, or a required gate. Accepting reported checks is not a correctness claim; review still inspects the actual diff. For Pi, questionId shows its reply and acknowledgement. For generic workers, submissionId shows plain-text intent and delivery without claiming acceptance. A missing observation means uncertain delivery; never resubmit that identity. readOutput reads bounded terminal text once from an active identity-checked generic worker; approval dialogs need user action. Reconnect never resubmits work or resets deadlines. The same parent session reattaches after restart when herdr confirms the saved worker identity. Only Pi supports completed-task follow-up. When saved records are unreadable, the result has no state; inspect its recovery for manual cleanup.',
    parameters: statusParameters,
    renderCall(parameters, theme) {
      return callText('Worker status', shortId(parameters.taskId), theme);
    },
    renderResult(result, options, theme) {
      return renderStatusResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return readWorkerStatus(runtime, parameters, context);
    },
  });
};

const registerReplyTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_reply',
    label: 'Reply to worker',
    description:
      'Send an in-scope reply to an active owned worker within its original deadline. Pi requires questionId and preserves structured acknowledgement. Generic workers omit questionId and receive plain text; delivery is not task acceptance or acknowledgement. Delivery values: sent (herdr accepted the text); notResent (this exact reply was already saved and was not sent again; prior Pi delivery may still be uncertain; do not retry); uncertain (delivery could not be confirmed; do not retry); notDelivered (a blocked native dialog refused input; user action is needed). Use a unique replyId and inspect subagent_status with submissionId after uncertainty. Native blocked or unknown state refuses input; never use this tool to approve native dialogs automatically.',
    parameters: replyParameters,
    renderCall(parameters, theme) {
      return callText('Reply to worker', shortId(parameters.taskId), theme);
    },
    renderResult(result, options, theme) {
      return renderReplyResult(result.details, options.expanded, theme);
    },
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return replyToWorker(runtime, parameters, context);
    },
  });
};

const registerCancelTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_cancel',
    label: 'Cancel worker',
    description:
      'Attempt bounded identity-checked cancellation using live or saved worker ownership. Failed herdr calls and active-work shutdown may require manual cleanup. Detached descendants are not contained.',
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
  registerLaunchTool(runtime);
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

export default function subagentsExtension(pi: ExtensionAPI): void {
  if (process.env.TAU_WORKER_RECORD) {
    return;
  }

  let controller: WorkerController | undefined;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let historyView: WorkerHistoryView | undefined;
  let historyOpen = false;
  let shuttingDown = false;
  const runtime: SubagentRuntime = {
    pi,
    getController: () => {
      controller ??= createController(pi);

      return controller;
    },
    peekController: () => controller,
  };

  registerSubagentTools(runtime);
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
      reason:
        'A worker is active. Worker notices wait until the current tool call finishes, so a sleep delays them. End your turn to wait; a notice starts a new turn when the worker asks, reports, or stops.',
    };
  });
  pi.registerMessageRenderer('tau-worker', (message, options, theme) =>
    renderNotice(message.details, options.expanded, theme),
  );

  pi.on('session_shutdown', async (event) => {
    shuttingDown = true;
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
}
