import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { isNestedControlCall, nestedControlCallReason } from '../../codemode/controlTools.js';
import type { Exec } from '../../command.js';
import {
  forgetReportedWarnings,
  readTauConfig,
  warnUnknownTopLevelKeys,
} from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { herdrPaneId, herdrSocketPath, insideHerdr } from '../../herdr.js';
import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isRecord } from '../../schema.js';
import { isWorkerProcess, workerNoticeChannel } from '../../worker.js';
import type { WorkerNoticeEvent } from '../../worker.js';
import { readBrowserLoginCommand } from './browserLogin.js';
import { capacityRefusalBlock, clearsCapacityRefusal } from './capacityRefusal.js';
import { hasParentTrackedWorkers, compactionWorkerList } from './compactionWorkers.js';
import { WorkerController } from './controller/controller.js';
import { evidenceResult, launchErrorResult } from './errorResult.js';
import { executeLaunch, millisecondsPerSecond } from './launch.js';
import { checkLaunchEnvironment } from './launchCheck.js';
import { launchParameters, visibility } from './launchParameters.js';
import type { LaunchParameters } from './launchParameters.js';
import { launchModels, requireTrustedProject } from './loadout.js';
import { delegationGuidelines } from './managerPrompt.js';
import { decideNoticeDelivery } from './noticeDelivery.js';
import { passiveWaitRefusal } from './passiveWait.js';
import { modelReply, modelStatus, stateLabel, stateLabels } from './presentation.js';
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
import { taskIdSchema } from './types.js';
import type { WorkerState } from './types.js';
import { renderWorkerWidget } from './widget.js';
import { readWorkerCapacity } from './workerCapacityConfig.js';
import { workerModelLine } from './workerModels.js';

interface CapacityRefusal {
  refuse: () => void;
}

interface SubagentRuntime {
  pi: ExtensionAPI;
  getController: (context: ExtensionContext) => Promise<WorkerController>;
  refuseCapacity: () => void;
}

type NoticeDelivery = (
  context: Pick<ExtensionContext, 'isIdle' | 'signal'> | undefined,
  notice: WorkerNotice,
) => void;

const widgetRefreshInterval = 1000;

const followUpParameters = Type.Object(
  {
    sourceTaskId: taskIdSchema,
    task: Type.String({ minLength: 1, maxLength: 32000 }),
    acceptance: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
        maxItems: 50,
        description:
          'Acceptance criteria, one per item. Required for editing profiles and follow-ups of editing workers.',
      }),
    ),
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

type FollowUpParameters = Static<typeof followUpParameters>;
type StatusParameters = Static<typeof statusParameters>;
type ReplyParameters = Static<typeof replyParameters>;
type CancelParameters = Static<typeof cancelParameters>;

const isWorkerState = (value: unknown): value is WorkerState =>
  typeof value === 'string' && Object.hasOwn(stateLabels, value);

const noticeEvent = (notice: WorkerNotice): WorkerNoticeEvent => {
  const details = isRecord(notice.details) ? notice.details : {};
  const { name, taskId, state, outcome } = details;
  const fallback = typeof taskId === 'string' && taskId !== '' ? shortId(taskId) : 'worker';
  const worker = typeof name === 'string' && name !== '' ? name : fallback;

  if (!isWorkerState(state)) {
    return { worker, label: 'evidence unreadable' };
  }

  const label = stateLabel(state, typeof outcome === 'string' ? outcome : undefined);

  return { worker, label: label.text };
};

export const createNoticeDelivery = (pi: ExtensionAPI): NoticeDelivery => {
  // Pi is busy during a run and during a manual compaction. Only a run takes a steered notice. The
  // extension context exposes no run state that also covers Pi's compaction after the agent loop.
  let runActive = false;

  pi.on('agent_start', () => {
    runActive = true;
  });

  pi.on('agent_settled', () => {
    runActive = false;
  });

  return (context, notice) => {
    pi.events.emit(workerNoticeChannel, noticeEvent(notice));

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

    if (step === 'wake') {
      pi.sendMessage(message, { triggerTurn: true });

      return;
    }

    pi.sendMessage(message, { deliverAs: 'nextTurn' });
  };
};

// The first caller's context supplies the cwd and trust that locate the user config.
const createController = (
  context: ExtensionContext,
  deliver: NoticeDelivery,
  getContext: () => ExtensionContext | undefined,
  registeredToolNames: () => readonly string[],
): WorkerController => {
  const capacity = readWorkerCapacity(
    { cwd: context.cwd, agentDirectory: getAgentDir(), projectTrusted: context.isProjectTrusted() },
    context.ui,
  );

  return new WorkerController(
    workerRecordsDirectory(),
    undefined,
    (notice) => {
      deliver(getContext(), notice);
    },
    undefined,
    capacity,
    registeredToolNames,
  );
};

const hasHerdrEnvironment = (): boolean => insideHerdr() && Boolean(herdrSocketPath());

const hasHerdrParentPane = (): boolean => hasHerdrEnvironment() && Boolean(herdrPaneId());

// Pi streams call arguments, so a renderer can run before the model finishes any field.
const callDetail = (parts: (string | undefined)[]): string | undefined => {
  const joined = parts.filter((part): part is string => Boolean(part)).join(' · ');

  return joined.length > 0 ? joined : undefined;
};

// Pi renders the call while its arguments still stream, so the profile can be missing or empty.
const launchTitle = (profile: string | undefined): string => {
  const name = profile === undefined || profile === '' ? 'subagent' : profile;

  return `Launch ${name}`;
};

const piExec =
  (pi: ExtensionAPI): Exec =>
  (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

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

  requireTrustedProject(context);
  const resolved = await checkLaunchEnvironment(parameters, signal, context, piExec(runtime.pi));

  return executeLaunch(
    runtime,
    { parameters: resolved, startedAt, parentSession },
    signal,
    context,
  );
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

  const controller = await runtime.getController(context);

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
    return launchErrorResult(runtime.refuseCapacity, error);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
    details: status,
  };
};

const readWorkerStatus = async (
  runtime: SubagentRuntime,
  parameters: StatusParameters,
  context: ExtensionContext,
) => {
  const parentSessionId = context.sessionManager.getSessionId();
  const active = await runtime.getController(context);

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

const replyToWorker = async (
  runtime: SubagentRuntime,
  parameters: ReplyParameters,
  context: ExtensionContext,
) => {
  const active = await runtime.getController(context);

  const receipt = active.reply(
    parameters.taskId,
    context.sessionManager.getSessionId(),
    parameters,
  );

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
    const active = await runtime.getController(context);

    status = await active.cancel(parameters.taskId, context.sessionManager.getSessionId());
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

const warnUnknownConfigKeys = (context: ExtensionContext): void => {
  try {
    const { files } = readTauConfig({
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });

    warnUnknownTopLevelKeys(context.ui, files);
  } catch {
    // The feature readers report an unreadable config file.
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
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'scopedModels' | 'ui'>,
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
      readProfileModels(location, context.ui),
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
    return readBrowserLoginCommand(
      {
        cwd: context.cwd,
        agentDirectory: getAgentDir(),
        projectTrusted: context.isProjectTrusted(),
      },
      context.ui,
    );
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
      'Editing workers require acceptance criteria. Brief them with, when it applies: outcome, scope and non-goals, entry files, decisions already made, baseline, and checks to run. Give the worktree; one editor per worktree. The deadline includes waits and cleanup.',
      'A notice starts a new turn when a worker asks, reports, or stops. End your turn to wait; never sleep or poll.',
    ].join(' '),
    promptSnippet: 'Launch Tau workers to scout, implement, or review work',
    parameters: launchParameters,
    renderCall(parameters, theme) {
      return callText(
        launchTitle(parameters.profile),
        callDetail([firstLine(parameters.task)]),
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
      return readWorkerStatus(runtime, parameters, context);
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
      return replyToWorker(runtime, parameters, context);
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

  // Launch needs herdr and a parent pane, so a manager outside herdr must not be told to delegate.
  const delegating = hasHerdrParentPane();
  let guidelines = delegationGuidelines(undefined);

  pi.on('before_agent_start', (event) => {
    if (delegating && event.systemPromptOptions.selectedTools.includes('subagent')) {
      appendSystemPrompt(event, guidelines.map((guideline) => `- ${guideline}`).join('\n'));
    }
  });

  const refreshWidget = (context: ExtensionContext): void => {
    if (shuttingDown || !context.hasUI || context.mode !== 'tui') {
      return;
    }

    if (controller === undefined) {
      return;
    }

    const rows = controller.widgetRows(context.sessionManager.getSessionId());

    if (rows.length === 0) {
      context.ui.setWidget('tau-subagents', undefined);
    } else {
      context.ui.setWidget(
        'tau-subagents',
        (_tui, theme) => {
          let cached: { width: number; second: number; lines: string[] } | undefined;

          return {
            invalidate() {
              cached = undefined;
            },
            render(width) {
              const now = Date.now();
              const second = Math.floor(now / millisecondsPerSecond);

              if (cached?.width !== width || cached.second !== second) {
                cached = { width, second, lines: renderWorkerWidget(rows, width, now, theme) };
              }

              return cached.lines;
            },
          };
        },
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

  let resumed: Promise<void> | undefined;

  // A controller created after session start, such as once a bad config is fixed, still resumes
  // the saved workers of this session. Tool calls wait for that resume before they use it.
  const ensureController = (context: ExtensionContext): WorkerController => {
    if (controller !== undefined) {
      return controller;
    }

    const created = createController(
      context,
      deliverNotice,
      () => sessionContext,
      () => pi.getAllTools().map((tool) => tool.name),
    );

    controller = created;

    const sessionId = context.sessionManager.getSessionId();

    resumed = (async () => {
      try {
        await created.resume(sessionId);
        refreshWidget(context);
      } catch (error) {
        context.ui.notify(`Saved workers could not be reattached: ${String(error)}`, 'error');
      }

      // Tool calls wait only for the resume, so deletion stays off their path and the widget's.
      created.deleteExpiredTasks(sessionId, Date.now()).catch((error: unknown) => {
        context.ui.notify(
          `Expired worker records could not be deleted: ${String(error)}`,
          'warning',
        );
      });
    })();

    return created;
  };

  const runtime: SubagentRuntime = {
    pi,
    getController: async (context) => {
      const active = ensureController(context);

      await resumed;

      return active;
    },
    refuseCapacity: capacityRefusal.refuse,
  };

  registerSubagentTools(runtime);

  pi.on('session_start', (_event, context) => {
    shuttingDown = false;
    sessionContext = context;
    forgetReportedWarnings(context.ui);
    warnUnknownConfigKeys(context);

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

    // An invalid config leaves the controller uncreated, and each worker tool call reports it.
    try {
      ensureController(context);
    } catch (error) {
      context.ui.notify(errorMessage(error), 'error');
    }

    refreshWidget(context);
  });

  pi.on('tool_result', (_event, context) => {
    refreshWidget(context);
  });

  pi.on('tool_call', (event, context) => {
    if (isNestedControlCall(event)) {
      return { block: true, reason: nestedControlCallReason };
    }

    const command = event.toolName === 'bash' ? event.input.command : undefined;

    if (typeof command !== 'string') {
      return undefined;
    }

    const rows = controller?.widgetRows(context.sessionManager.getSessionId()) ?? [];

    const reason = passiveWaitRefusal(command, {
      hasActiveWorkers: hasParentTrackedWorkers(rows),
      delegating,
    });

    if (reason === undefined) {
      return undefined;
    }

    return { block: true, reason };
  });

  pi.registerMessageRenderer('tau-worker', (message, options, theme) =>
    renderNotice(message.details, options.expanded, theme),
  );

  // Pi's summary drops exact task IDs and question IDs, so the list joins the next prompt.
  pi.on('session_compact', (_event, context) => {
    if (controller === undefined) {
      return;
    }

    const rows = controller.widgetRows(context.sessionManager.getSessionId());
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
    resumed = undefined;
  });
}
