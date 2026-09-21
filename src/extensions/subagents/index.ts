/* oxlint-disable node/no-process-env -- Worker ownership and herdr connection come from the active Pi process. */
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { WorkerController } from './controller.js';
import { historyPage, searchHistory } from './history.js';
import { resolveInheritedLoadout, resolveLoadout } from './loadout.js';

const visibility = Type.Optional(
  StringEnum(['foreground', 'background'] as const, {
    description:
      'Foreground shares useful space with the parent. Background uses inspectable worker tabs. Neither changes focus. Default: foreground; overflow uses a tab.',
  }),
);

export default function subagentsExtension(pi: ExtensionAPI): void {
  let controller: WorkerController | undefined;
  let nested = false;
  const removeChildrenListener = pi.events.on('tau:worker-children', (value: unknown) => {
    if (value && typeof value === 'object') {
      Object.assign(value, controller?.children() ?? { active: 0, uncertain: [] });
    }
  });
  const getController = () => {
    controller ??= new WorkerController(
      join(getAgentDir(), 'tau', 'workers'),
      undefined,
      (message, question) => {
        if (nested) {
          pi.events.emit('tau:child-notification', { message, question });

          return;
        }

        pi.sendMessage(
          { customType: 'tau-worker', content: message, display: true, details: question },
          question ? { deliverAs: 'steer', triggerTurn: true } : { deliverAs: 'nextTurn' },
        );
      },
    );

    return controller;
  };
  pi.on('session_shutdown', () => {
    removeChildrenListener();
    controller?.close();
    controller = undefined;
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Launch worker',
    description:
      'Launch a bounded worker in herdr. Pi (default) requires trusted-full-tools and verified CC Safety Net; its model must be explicit or configured. Other herdr kinds use native-controls, which Tau does not certify. Their nativeArguments list and existing writable reportDirectory need explicit parent-user confirmation before launch. No native arguments by default; the harness selects its configured model. An exact native model request requires corresponding user-approved arguments, but Tau cannot verify the model used. Native approval dialogs remain in force and need user action. Tau adds no bypass flags and never approves dialogs. Model translation, native resume, and a Tau nesting channel are unavailable for non-Pi workers. Reports are required from the start. All workers share root capacity and one original deadline, including waits and cleanup. No uncertain retries or fallback. Built-in profiles: investigator and worker.',
    parameters: Type.Object({
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
    }),
    async execute(_id, parameters, signal, _update, context) {
      signal?.throwIfAborted();
      const startedAt = { wall: Date.now(), monotonic: performance.now() };
      const timeout = parameters.timeoutSeconds * 1000;
      const workBudget = timeout - Math.min(5000, Math.floor(timeout / 4));
      const resolutionSignal = AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(workBudget),
      ]);
      const parentPane = process.env.HERDR_PANE_ID;
      const parentSession = context.sessionManager.getSessionFile();

      if (
        process.env.HERDR_ENV !== '1' ||
        !parentPane ||
        !process.env.HERDR_SOCKET_PATH ||
        !parentSession
      ) {
        throw new Error('Worker launch requires a saved parent Pi session inside local herdr.');
      }

      const active = getController();
      const authority = await active.parentAuthority(
        parentSession,
        context.sessionManager.getSessionId(),
        resolutionSignal,
      );

      if (
        authority.parent &&
        (parameters.nativeArguments !== undefined || parameters.reportDirectory !== undefined)
      ) {
        throw new Error('Nested workers cannot supply native launch configuration.');
      }

      nested = Boolean(authority.parent);
      const loadout = authority.parent
        ? await resolveInheritedLoadout(authority.parent, parameters, context, pi, resolutionSignal)
        : await resolveLoadout(parameters, context, pi, resolutionSignal);
      signal?.throwIfAborted();
      const status = await active.launch(
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

      return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status };
    },
  });
  pi.registerTool({
    name: 'subagent_follow_up',
    label: 'Follow up completed worker',
    description:
      'Assign a new bounded Pi task to an exact saved task ID in the current root-session tree. Requires a final report and confirmed cleanup. Reuses the exact Pi session and unchanged settings. Non-Pi continuation refuses; start a fresh task. One successor claim per task; no uncertain retry or age-based reclaim. Searching grants no live ownership.',
    parameters: Type.Object(
      {
        sourceTaskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
        task: Type.String({ minLength: 1, maxLength: 32000 }),
        timeoutSeconds: Type.Integer({ minimum: 10, maximum: 86400 }),
        settingsUnchanged: Type.Literal(true),
        visibility,
      },
      { additionalProperties: false },
    ),
    async execute(_id, parameters, signal, _update, context) {
      const parentSession = context.sessionManager.getSessionFile();
      const parentPane = process.env.HERDR_PANE_ID;

      if (
        process.env.HERDR_ENV !== '1' ||
        !parentSession ||
        !parentPane ||
        !process.env.HERDR_SOCKET_PATH
      ) {
        throw new Error('Follow-up requires a saved parent session inside local herdr.');
      }

      const active = getController();
      const authority = await active.parentAuthority(
        parentSession,
        context.sessionManager.getSessionId(),
        signal,
      );
      nested = Boolean(authority.parent);
      const status = await active.followUp(
        {
          ...parameters,
          timeout: parameters.timeoutSeconds * 1000,
          parentSession,
          parentSessionId: context.sessionManager.getSessionId(),
        },
        context,
        signal,
      );

      return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status };
    },
  });
  pi.registerTool({
    name: 'subagent_history',
    label: 'Search session history',
    description:
      'Read-only name, task ID, native session ID, or description search within the current root session and its descendants. Includes bounded previews of saved reports and native references after pane cleanup. Use nextOffset with the same query to page. Read sourceFile for complete records. Match counts include all matches, not just the page. Multiple matches require clarification using full IDs; never choose the newest. Does not grant reply/cancel ownership, resume work, or copy transcripts.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_id, parameters, signal, _update, context) {
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

      return { content: [{ type: 'text', text: JSON.stringify(page) }], details: page };
    },
  });
  pi.registerTool({
    name: 'subagent_status',
    label: 'Worker status',
    description:
      'Recover task results and saved native references. For Pi, questionId shows its reply and acknowledgement. For generic workers, submissionId shows plain-text intent and delivery without claiming acceptance. readOutput reads bounded terminal text once from an active identity-checked generic worker; approval dialogs need user action. Reconnect never resubmits work or resets deadlines. Recovery after parent exit is saved evidence only. Only Pi supports completed-task follow-up.',
    parameters: Type.Object({
      taskId: Type.String(),
      questionId: Type.Optional(Type.String()),
      submissionId: Type.Optional(Type.String()),
      readOutput: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, parameters, _signal, _update, context) {
      const parentSessionId = context.sessionManager.getSessionId();
      const active = getController();
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
    },
  });
  pi.registerTool({
    name: 'subagent_reply',
    label: 'Reply to worker',
    description:
      'Send an in-scope reply to an active owned worker within its original deadline. Pi requires questionId and preserves structured acknowledgement. Generic workers omit questionId and receive plain text; delivery is not task acceptance or acknowledgement. Use a unique replyId and inspect subagent_status with submissionId after uncertainty. Repeated identities never resend. Native blocked or unknown state refuses input; never use this tool to approve native dialogs automatically.',
    parameters: Type.Object(
      {
        taskId: Type.String(),
        questionId: Type.Optional(Type.String()),
        replyId: Type.String({ pattern: '^[a-zA-Z0-9-]{1,128}$' }),
        reply: Type.String({ minLength: 1, maxLength: 32000 }),
        scopeUnchanged: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    async execute(_id, parameters, _signal, _update, context) {
      const receipt = await getController().reply(
        parameters.taskId,
        context.sessionManager.getSessionId(),
        parameters,
      );

      return { content: [{ type: 'text', text: JSON.stringify(receipt) }], details: receipt };
    },
  });
  pi.registerTool({
    name: 'subagent_cancel',
    label: 'Cancel worker',
    description:
      'Attempt bounded identity-checked cancellation of an owned worker. Failed herdr calls and active-work shutdown may require manual cleanup. Detached descendants are not contained.',
    parameters: Type.Object({ taskId: Type.String() }),
    async execute(_id, parameters, _signal, _update, context) {
      const status = await getController().cancel(
        parameters.taskId,
        context.sessionManager.getSessionId(),
      );

      return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status };
    },
  });
}
