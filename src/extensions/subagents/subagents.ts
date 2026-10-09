/* oxlint-disable node/no-process-env -- The herdr connection comes from the active Pi process. */

import { StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { isNestedControlCall, nestedControlCallReason } from '../../controlTools.js';
import { errorMessage } from '../../errors.js';
import { readGitOutput } from '../../gitOutput.js';
import { appendSystemPrompt } from '../../systemPrompt.js';
import type { ConfigLocation } from '../../tauConfig.js';
import { isWorkerProcess } from '../../workerProcess.js';
import { readBrowserLoginCommand } from './browserLogin.js';
import { capacityRefusalBlock, clearsCapacityRefusal } from './capacityRefusal.js';
import { hasParentTrackedWorkers, compactionWorkerList } from './compactionWorkers.js';
import { WorkerCapacityFullError, WorkerController } from './controller/controller.js';
import { EvidenceUnavailableError } from './controller/record.js';
import { launchModels, resolveLoadout } from './loadout.js';
import { delegationGuidelines } from './managerPrompt.js';
import { decideNoticeDelivery } from './noticeDelivery.js';
import { modelEvidenceNotice, modelReply, modelStatus } from './presentation.js';
import type { WorkerNotice } from './presentation.js';
import { readProfileModels } from './profileModels.js';
import { listProfiles } from './profiles.js';
import type { ProfileSummary } from './profiles.js';
import { workerRecordsDirectory } from './records.js';
import {
  callText,
  firstLine,
  renderNotice,
  renderReplyResult,
  renderStatusResult,
  shortId,
} from './render.js';
import { readTrackerSetup } from './trackerConfig.js';
import { trackerLines } from './trackerRouting.js';
import { taskIdSchema } from './types.js';
import { renderWorkerWidget } from './widget.js';
import { workerModelLine } from './workerModels.js';

interface CapacityRefusal {
  refuse: () => void;
}

interface SubagentRuntime {
  pi: ExtensionAPI;
  getController: () => WorkerController;
  refuseCapacity: () => void;
}

type NoticeDelivery = (
  context: Pick<ExtensionContext, 'isIdle' | 'signal'> | undefined,
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
const millisecondsPerSecond = 1000;
const widgetRefreshInterval = 1000;
// A sleep this long while workers run waits on them, so the call is blocked.
const blockedSleepSeconds = 30;

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
type StatusParameters = Static<typeof statusParameters>;
type ReplyParameters = Static<typeof replyParameters>;
type CancelParameters = Static<typeof cancelParameters>;

// A notice turn whose prompt fails before agent_start leaves later idle notices queued
// for the next user prompt instead of starting a turn.
export const createNoticeDelivery = (pi: ExtensionAPI): NoticeDelivery => {
  // The prompt a notice starts consumes every nextTurn message queued before its run begins.
  let turnStarting = false;
  // Pi is busy during a run and during a manual compaction. Only a run takes a steered notice. The
  // extension context exposes no run state that also covers Pi's compaction after the agent loop.
  let runActive = false;

  pi.on('agent_start', () => {
    turnStarting = false;
    runActive = true;
  });

  pi.on('agent_settled', () => {
    runActive = false;
  });

  return (context, notice) => {
    const message = {
      customType: 'tau-worker',
      content: JSON.stringify(notice.content),
      display: true,
      details: notice.details,
    };

    const step = decideNoticeDelivery({
      piIdle: context?.isIdle(),
      runActive,
      agentRunning: context?.signal !== undefined,
    });

    if (step === 'steer') {
      pi.sendMessage(message, { deliverAs: 'steer', triggerTurn: true });

      return;
    }

    pi.sendMessage(message, { deliverAs: 'nextTurn' });

    // An idle triggerTurn skips the prompt hook and Tau's additions, which pi-claude-bridge
    // rejects. A user message starts the turn through that hook.
    if (step === 'wake' && !turnStarting) {
      turnStarting = true;
      pi.sendUserMessage('A worker notice arrived.', { deliverAs: 'steer' });
    }
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

const launchErrorResult = (runtime: SubagentRuntime, error: unknown) => {
  if (error instanceof WorkerCapacityFullError) {
    runtime.refuseCapacity();

    return {
      content: [{ type: 'text' as const, text: error.message }],
      details: undefined,
      isError: true,
      terminate: true,
    };
  }

  return evidenceResult(error);
};

const launchWorker = async (
  runtime: SubagentRuntime,
  parameters: LaunchParameters,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => {
  signal?.throwIfAborted();
  const startedAt = { wall: Date.now(), monotonic: performance.now() };

  const parentSession = context.sessionManager.getSessionFile();

  if (!hasHerdrParentPane()) {
    throw new Error('Worker launch requires a saved parent Pi session inside local herdr.');
  }

  if (parentSession == null || parentSession === '') {
    throw new Error('Worker launch requires a saved parent Pi session inside local herdr.');
  }

  const controller = runtime.getController();
  const loadout = resolveLoadout(parameters, context, runtime.pi.getCommands());

  const timeout =
    (parameters.timeoutSeconds ?? defaultTimeoutSeconds[loadout.role]) * millisecondsPerSecond;

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
    return launchErrorResult(runtime, error);
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
  const parentSession = context.sessionManager.getSessionFile();

  if (!hasHerdrParentPane()) {
    throw new Error('Follow-up requires a saved parent session inside local herdr.');
  }

  if (parentSession == null || parentSession === '') {
    throw new Error('Follow-up requires a saved parent session inside local herdr.');
  }

  const controller = runtime.getController();

  let status: Awaited<ReturnType<WorkerController['followUp']>>;

  try {
    status = await controller.followUp(
      {
        ...parameters,
        timeout: parameters.timeoutSeconds * millisecondsPerSecond,
        parentSession,
        parentSessionId: context.sessionManager.getSessionId(),
      },
      context,
      signal,
    );
  } catch (error) {
    return launchErrorResult(runtime, error);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
    details: status,
  };
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

// A config that cannot be read leaves the line out, and each launch reports the error.
const launchModelLine = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'scopedModels'>,
  profiles: ProfileSummary[],
): string[] => {
  try {
    const location = {
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    };

    const names = profiles.map(({ name }) => name);

    const line = workerModelLine(
      launchModels(context, location),
      names,
      readProfileModels(location),
    );

    return line === undefined ? [] : [line];
  } catch {
    return [];
  }
};

// A broken login command leaves the command out, so the manager still sends browser work.
const browserLoginCommand = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
): string | undefined => {
  try {
    return readBrowserLoginCommand({
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
  } catch (error) {
    context.ui.notify(errorMessage(error), 'error');

    return undefined;
  }
};

const registerLaunchTool = (
  runtime: SubagentRuntime,
  profiles: ProfileSummary[],
  modelLine: string[] = [],
): void => {
  runtime.pi.registerTool({
    name: 'subagent',
    exposure: 'model-only',
    label: 'Launch worker',
    description: [
      'Launch a Pi worker in a herdr pane. cwd must match this session.',
      `Profiles: ${profileText(profiles)}. model overrides the profile default as provider/id.`,
      ...modelLine,
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
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return launchWorker(runtime, parameters, signal, context);
    },
  });
};

const registerFollowUpTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_follow_up',
    exposure: 'model-only',
    label: 'Follow up completed worker',
    description: [
      'Give a stopped worker from this parent session a new task in its saved session and settings.',
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
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return followUpWorker(runtime, parameters, signal, context);
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
    execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return Promise.resolve().then(() => readWorkerStatus(runtime, parameters, context));
    },
  });
};

const registerReplyTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_reply',
    exposure: 'model-only',
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
    execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return Promise.resolve(replyToWorker(runtime, parameters, context));
    },
  });
};

const registerCancelTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_cancel',
    exposure: 'model-only',
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
  registerStatusTool(runtime);
  registerReplyTool(runtime);
  registerCancelTool(runtime);
};

// Outside a repository, or without an origin remote, Git fails and no repository entry applies.
const readOriginUrl = async (cwd: string): Promise<string | undefined> => {
  const output = await readGitOutput(cwd, ['remote', 'get-url', 'origin']);

  return output?.trim();
};

const trackerGuidelines = async (location: ConfigLocation) => {
  const setup = readTrackerSetup(location);
  const originUrl = setup.status === 'read' ? await readOriginUrl(location.cwd) : undefined;

  return trackerLines({ setup, originUrl });
};

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

export const registerCapacityRefusal = (pi: ExtensionAPI): CapacityRefusal => {
  if (isWorkerProcess()) {
    return { refuse: () => undefined };
  }

  let capacityRefused = false;

  pi.on('session_start', () => {
    capacityRefused = false;
  });

  pi.on('message_start', (event) => {
    if (clearsCapacityRefusal(event.message)) {
      capacityRefused = false;
    }
  });

  pi.on('tool_call', () => capacityRefusalBlock(capacityRefused));

  return {
    refuse: () => {
      capacityRefused = true;
    },
  };
};

export default function subagentsExtension(
  pi: ExtensionAPI,
  capacityRefusal: CapacityRefusal,
): void {
  if (isWorkerProcess()) {
    return;
  }

  let controller: WorkerController | undefined;
  let sessionContext: ExtensionContext | undefined;
  const deliverNotice = createNoticeDelivery(pi);
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;

  const runtime: SubagentRuntime = {
    pi,
    getController: () => {
      controller ??= createController(deliverNotice, () => sessionContext);

      return controller;
    },
    refuseCapacity: capacityRefusal.refuse,
  };

  registerSubagentTools(runtime);
  // Launch needs herdr and a parent pane, so a manager outside herdr must not be told to delegate.
  const delegating = hasHerdrParentPane();
  let guidelines = delegationGuidelines(undefined);

  // Any Linear write follows the tracker skill, with or without delegation, so every manager
  // session gets the tracker lines.
  let tracker: string[] = [];

  pi.on('before_agent_start', (event) => {
    if (delegating && event.systemPromptOptions.selectedTools.includes('subagent')) {
      appendSystemPrompt(event, guidelines.map((guideline) => `- ${guideline}`).join('\n'));
    }

    if (tracker.length > 0) {
      appendSystemPrompt(event, tracker.map((line) => `- ${line}`).join('\n'));
    }
  });

  const refreshWidget = (context: ExtensionContext): void => {
    if (shuttingDown || !context.hasUI || context.mode !== 'tui') {
      return;
    }

    const rows = runtime.getController().widgetRows(context.sessionManager.getSessionId());

    if (rows.length === 0) {
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

    const refreshIsNeeded = hasParentTrackedWorkers(rows);

    if (refreshIsNeeded) {
      widgetTimer ??= setInterval(() => {
        refreshWidget(context);
      }, widgetRefreshInterval);
    } else if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
  };

  pi.on('session_start', async (_event, context) => {
    shuttingDown = false;
    sessionContext = context;

    // Project profiles and scoped models load only once the session's cwd and trust are known.
    // The description stays fixed for the session, so the prompt cache holds.
    const profiles = launchProfiles(context);

    registerLaunchTool(runtime, profiles, launchModelLine(context, profiles));

    if (delegating) {
      guidelines = delegationGuidelines(browserLoginCommand(context));
    }

    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }

    runtime
      .getController()
      .resume(context.sessionManager.getSessionId())
      .then(() => {
        refreshWidget(context);
      })
      .catch((error: unknown) => {
        context.ui.notify(`Saved workers could not be reattached: ${String(error)}`, 'error');
      });

    refreshWidget(context);

    const location = {
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    };

    tracker = await trackerGuidelines(location);
  });

  pi.on('tool_result', (_event, context) => {
    refreshWidget(context);
  });

  pi.on('tool_call', (event, context) => {
    if (isNestedControlCall(event)) {
      return { block: true, reason: nestedControlCallReason };
    }

    const command = event.toolName === 'bash' ? event.input.command : undefined;

    if (typeof command !== 'string' || totalSleepSeconds(command) < blockedSleepSeconds) {
      return undefined;
    }

    const rows = controller?.widgetRows(context.sessionManager.getSessionId()) ?? [];

    if (!hasParentTrackedWorkers(rows)) {
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

  // Pi's summary drops exact task IDs and question IDs, so the list joins the next prompt.
  pi.on('session_compact', (_event, context) => {
    const rows = runtime.getController().widgetRows(context.sessionManager.getSessionId());
    const list = compactionWorkerList(rows);

    if (list === undefined) {
      return;
    }

    pi.sendMessage(
      { customType: 'tau-worker-ledger', content: list, display: false },
      { deliverAs: 'nextTurn' },
    );
  });

  pi.on('session_shutdown', async (event) => {
    shuttingDown = true;
    sessionContext = undefined;

    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }

    await controller?.stopAll(event.reason);
    controller = undefined;
  });
}
