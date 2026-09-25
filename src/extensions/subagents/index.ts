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

interface SubagentRuntime {
  pi: ExtensionAPI;
  getController: () => WorkerController;
  peekController: () => WorkerController | undefined;
}

const visibility = Type.Optional(
  StringEnum(['foreground', 'background'] as const, {
    description: [
      'Choose foreground for visible work or background for separate worker tabs. foreground is the default.',
      'Foreground shares parent or worker space, falling back to a separate tab when space is too small.',
      'Both preserve focus, manual split ratios, and unrelated panes.',
    ].join(' '),
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

const readWorkerStatus = async (
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

    const submissionReceipt =
      parameters.submissionId != null && parameters.submissionId !== ''
        ? active.submissionReceipt(parameters.taskId, parentSessionId, parameters.submissionId)
        : undefined;

    const nativeOutput =
      parameters.readOutput === true
        ? await active.nativeOutput(parameters.taskId, parentSessionId)
        : undefined;

    const status = { ...current, questionReceipt: receipt, submissionReceipt, nativeOutput };

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
    description: [
      'Launch a herdr worker. Requires task, profile, permissions, timeoutSeconds; cwd must match this session.',
      'Built-in profiles: investigator, worker. Pi is the default harness.',
      'Pi needs trusted-full-tools, CC Safety Net, and an explicit or configured provider/id model.',
      'Set harness for a non-Pi kind; Pi workers refuse nativeArguments.',
      'Other harnesses need native-controls and writable cwd/.tau/workers/<taskId>/report.md.',
      'Literal nativeArguments default empty; model requests need native flags. Tau neither verifies native models or controls nor approves dialogs.',
      'Assign acceptance criteria, baseline, worktree, one editor per worktree.',
      'Expect a report with Changes, Evidence, Decisions, and Concerns sections.',
      'Workers cannot launch workers; ask the parent. Each parent caps its live workers. The deadline includes waits and cleanup.',
      'Returns state: starting (not accepted); running (Pi accepted or native text sent); awaitingReply (waiting for parent); reported (report saved, cleanup pending);',
      'stopping (cleanup running); stopped (cleanup confirmed); cleanupUnconfirmed (manual cleanup, references kept); notOwned (no verified handle, may still run).',
      'When a worker asks, reports, or stops, a status notice starts a new parent turn after the current tool call finishes.',
      'End your turn to wait; never sleep or poll.',
      'No state means unreadable records; inspect recovery.',
    ].join(' '),
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
      'Assign a new task in a saved Pi session. Requires sourceTaskId from session history, task, timeoutSeconds, and settingsUnchanged: true.',
      'The source must be stopped with a report and no successorTaskId; its native session must not be live.',
      'Returns the new task status, reusing the saved session and settings. Only Pi supports follow-up; start a fresh task for other harnesses.',
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
      'Search earlier work in this session history by name, task or native session ID, or description. No required inputs; query, offset, and limit are optional.',
      'Returns candidates and totalMatches, excluding current and ancestor sessions. Use nextOffset with the same query to page; additions can shift pages.',
      'truncatedFields marks previews, not exact IDs or paths; reportFile locates a truncated report. Clarify multiple matches using full IDs.',
      'Search does not grant control of workers.',
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
      'Read a direct child task. Requires taskId; questionId selects Pi reply and acknowledgement, submissionId selects native delivery, readOutput reads active native terminal text.',
      'Returns state, saved references, and report evidence for the work it names, not proof of correctness. Missing delivery observation means uncertain; do not resend.',
      'The same parent session reattaches after restart when herdr confirms worker identity, without redispatch or a new deadline.',
      'No state means unreadable records; inspect recovery.',
    ].join(' '),
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
    description: [
      "Reply within an active owned worker's scope and deadline. Requires taskId, unique replyId, reply, and scopeUnchanged: true.",
      'Only Pi supports structured questions: supply questionId. Other harnesses take plain text without questionId; replyId cannot be assignment.',
      'Returns delivery: sent (herdr accepted text); notResent (saved reply, not sent again; Pi delivery may remain uncertain);',
      'uncertain (unconfirmed, do not retry); notDelivered (dialog blocked input, user action needed). Delivery is not task acceptance or acknowledgement.',
      'Inspect status with questionId for Pi or submissionId for other harnesses. Tau refuses blocked or unknown native state and never approves dialogs.',
    ].join(' '),
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
    description: [
      "Cancel a worker using live or saved identity. Requires this parent's taskId.",
      'Returns cleanup status; cleanupUnconfirmed needs manual cleanup. Detached descendants are not contained.',
    ].join(' '),
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
  if (process.env.TAU_WORKER_RECORD != null && process.env.TAU_WORKER_RECORD !== '') {
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
