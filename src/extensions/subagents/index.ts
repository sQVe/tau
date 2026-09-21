/* oxlint-disable node/no-process-env -- Worker ownership and herdr connection come from the active Pi process. */
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { WorkerController } from './controller.js';
import { historyPage, searchHistory } from './history.js';
import { resolveInheritedLoadout, resolveLoadout } from './loadout.js';
import type { Question } from './types.js';

const visibility = Type.Optional(
  StringEnum(['foreground', 'background'] as const, {
    description:
      'Foreground shares useful space with the parent. Background uses inspectable worker tabs. Neither changes focus. Default: foreground; overflow uses a tab.',
  }),
);

const launchParameters = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 32_000 }),
  profile: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  harness: Type.Optional(Type.String()),
  nativeArguments: Type.Optional(
    Type.Array(Type.String({ maxLength: 8000, pattern: '^[^\\u0000]*$' }), { maxItems: 100 }),
  ),
  reportDirectory: Type.Optional(Type.String()),
  visibility,
  permissions: StringEnum(['trusted-full-tools', 'native-controls'] as const),
  timeoutSeconds: Type.Integer({ minimum: 10, maximum: 86_400 }),
});

const followUpParameters = Type.Object(
  {
    sourceTaskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
    task: Type.String({ minLength: 1, maxLength: 32000 }),
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
  setNested: (value: boolean) => void;
}

const notifyParent = (
  pi: ExtensionAPI,
  isNested: () => boolean,
  message: string,
  question: Question | undefined,
): void => {
  if (isNested()) {
    pi.events.emit('tau:child-notification', { message, question });

    return;
  }

  pi.sendMessage(
    { customType: 'tau-worker', content: message, display: true, details: question },
    question ? { deliverAs: 'steer', triggerTurn: true } : { deliverAs: 'nextTurn' },
  );
};

const createController = (pi: ExtensionAPI, isNested: () => boolean): WorkerController =>
  new WorkerController(join(getAgentDir(), 'tau', 'workers'), undefined, (message, question) => {
    notifyParent(pi, isNested, message, question);
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

const hasNativeConfiguration = (parameters: LaunchParameters): boolean =>
  parameters.nativeArguments !== undefined || parameters.reportDirectory !== undefined;

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
  const authority = await controller.parentAuthority(
    parentSession,
    context.sessionManager.getSessionId(),
    resolutionSignal,
  );

  if (authority.parent && hasNativeConfiguration(parameters)) {
    throw new Error('Nested workers cannot supply native launch configuration.');
  }

  runtime.setNested(Boolean(authority.parent));

  const loadout = authority.parent
    ? await resolveInheritedLoadout({
        parent: authority.parent,
        input: parameters,
        context,
        pi: runtime.pi,
        signal: resolutionSignal,
      })
    : await resolveLoadout(parameters, context, runtime.pi, resolutionSignal);
  signal?.throwIfAborted();

  const status = await controller.launch(
    {
      task: parameters.task,
      loadout,
      timeout,
      startedAt,
      parentSession,
      parentSessionId: context.sessionManager.getSessionId(),
      ...(parameters.visibility ? { visibility: parameters.visibility } : {}),
    },
    signal,
  );

  return { content: [{ type: 'text' as const, text: JSON.stringify(status) }], details: status };
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
  const authority = await controller.parentAuthority(
    parentSession,
    context.sessionManager.getSessionId(),
    signal,
  );
  runtime.setNested(Boolean(authority.parent));

  const status = await controller.followUp(
    {
      ...parameters,
      timeout: parameters.timeoutSeconds * 1000,
      parentSession,
      parentSessionId: context.sessionManager.getSessionId(),
    },
    context,
    signal,
  );

  return { content: [{ type: 'text' as const, text: JSON.stringify(status) }], details: status };
};

const searchWorkerHistory = async (
  parameters: HistoryParameters,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => {
  signal?.throwIfAborted();
  const file = context.sessionManager.getSessionFile();

  if (!file) {
    throw new Error('History requires a saved current session.');
  }

  const history = await searchHistory(
    join(getAgentDir(), 'tau', 'workers'),
    {
      file,
      id: context.sessionManager.getSessionId(),
      sessionDirectory: context.sessionManager.getSessionDir(),
    },
    parameters.query,
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
    content: [{ type: 'text' as const, text: JSON.stringify(status) }],
    details: status,
  };
};

const replyToWorker = async (
  runtime: SubagentRuntime,
  parameters: ReplyParameters,
  context: ExtensionContext,
) => {
  const receipt = await runtime
    .getController()
    .reply(parameters.taskId, context.sessionManager.getSessionId(), parameters);

  return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }], details: receipt };
};

const cancelWorker = async (
  runtime: SubagentRuntime,
  parameters: CancelParameters,
  context: ExtensionContext,
) => {
  const status = await runtime
    .getController()
    .cancel(parameters.taskId, context.sessionManager.getSessionId());

  return { content: [{ type: 'text' as const, text: JSON.stringify(status) }], details: status };
};

const registerLaunchTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent',
    label: 'Launch worker',
    description:
      'Launch a bounded worker in herdr. Pi (default) requires trusted-full-tools and verified CC Safety Net; its model must be explicit or configured. Other herdr kinds use native-controls, which Tau does not certify. Their nativeArguments list and existing writable reportDirectory need explicit parent-user confirmation before launch. No native arguments by default; the harness selects its configured model. An exact native model request requires corresponding user-approved arguments, but Tau cannot verify the model used. Native approval dialogs remain in force and need user action. Tau adds no bypass flags and never approves dialogs. Model translation, native resume, and a Tau nesting channel are unavailable for non-Pi workers. Reports are required from the start. All workers share root capacity and one original deadline, including waits and cleanup. No uncertain retries or fallback. Built-in profiles: investigator and worker.',
    parameters: launchParameters,
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
      'Assign a new bounded Pi task to an exact saved task ID in the current root-session tree. Requires a final report and confirmed cleanup. Reuses the exact Pi session and unchanged settings. Non-Pi continuation refuses; start a fresh task. One successor claim per task; no uncertain retry or age-based reclaim. Searching grants no live ownership.',
    parameters: followUpParameters,
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
      'Read-only name, task ID, native session ID, or description search within the current root session and its descendants. Includes bounded previews of saved reports and native references after pane cleanup. Use nextOffset with the same query to page. Read sourceFile for complete records. Match counts include all matches, not just the page. Multiple matches require clarification using full IDs; never choose the newest. Does not grant reply/cancel ownership, resume work, or copy transcripts.',
    parameters: historyParameters,
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return searchWorkerHistory(parameters, signal, context);
    },
  });
};

const registerStatusTool = (runtime: SubagentRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_status',
    label: 'Worker status',
    description:
      'Recover task results and saved native references. For Pi, questionId shows its reply and acknowledgement. For generic workers, submissionId shows plain-text intent and delivery without claiming acceptance. readOutput reads bounded terminal text once from an active identity-checked generic worker; approval dialogs need user action. Reconnect never resubmits work or resets deadlines. Recovery after parent exit is saved evidence only. Only Pi supports completed-task follow-up.',
    parameters: statusParameters,
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
      'Send an in-scope reply to an active owned worker within its original deadline. Pi requires questionId and preserves structured acknowledgement. Generic workers omit questionId and receive plain text; delivery is not task acceptance or acknowledgement. Use a unique replyId and inspect subagent_status with submissionId after uncertainty. Repeated identities never resend. Native blocked or unknown state refuses input; never use this tool to approve native dialogs automatically.',
    parameters: replyParameters,
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
      'Attempt bounded identity-checked cancellation of an owned worker. Failed herdr calls and active-work shutdown may require manual cleanup. Detached descendants are not contained.',
    parameters: cancelParameters,
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

export default function subagentsExtension(pi: ExtensionAPI): void {
  let controller: WorkerController | undefined;
  let nested = false;
  const removeChildrenListener = pi.events.on('tau:worker-children', (value: unknown) => {
    if (value && typeof value === 'object') {
      Object.assign(value, controller?.children() ?? { active: 0, uncertain: [] });
    }
  });
  const runtime: SubagentRuntime = {
    pi,
    getController: () => {
      controller ??= createController(pi, () => nested);

      return controller;
    },
    setNested: (value: boolean) => {
      nested = value;
    },
  };

  registerSubagentTools(runtime);

  pi.on('session_shutdown', () => {
    removeChildrenListener();
    controller?.close();
    controller = undefined;
  });
}
