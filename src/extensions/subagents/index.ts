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
      'Launch a trusted full-tool Pi or Claude Code investigator or editing worker in herdr. Requires user authorization and CC Safety Net. Fresh context, fixed parent-owned timeout, no automatic retry. Built-in profiles: investigator and worker. Set harness to pi (default) or claude; a profile may pin its own. Set model explicitly or TAU_SUBAGENT_MODEL for Pi; Claude needs an exact model and saved bypassPermissions settings. Other harnesses refuse. Nested workers inherit exact model/settings and share one root cap (TAU_SUBAGENT_CAP, default 4, saved at first admission). Waiting workers consume slots. Full or busy admission refuses promptly without a queue.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 32_000 }),
      profile: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      harness: Type.Optional(Type.String()),
      visibility,
      permissions: Type.Literal('trusted-full-tools'),
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
      if (!parentPane || !process.env.HERDR_SOCKET_PATH || !parentSession) {
        throw new Error('Worker launch requires a saved parent Pi session inside local herdr.');
      }
      const active = getController();
      active.project = { cwd: context.cwd, isProjectTrusted: () => context.isProjectTrusted() };
      const authority = await active.parentAuthority(
        parentSession,
        context.sessionManager.getSessionId(),
        resolutionSignal,
      );
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
      'Explicitly assign a new bounded task to an exact saved task ID in the current root-session tree. Requires a valid final report and confirmed parent cleanup. Reuses its exact native session and unchanged saved settings, not current profiles. One successor claim per task; uncertain attempts are never retried or reclaimed by age. Refuses known live native writers. Claims coordinate Tau only, not arbitrary manual Pi writers. Searching alone grants no active reply/cancel ownership.',
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
      if (!parentSession || !parentPane || !process.env.HERDR_SOCKET_PATH) {
        throw new Error('Follow-up requires a saved parent session inside local herdr.');
      }
      const active = getController();
      active.project = { cwd: context.cwd, isProjectTrusted: () => context.isProjectTrusted() };
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
      'Recover validated task results, pending questions, native references, and available native usage by task ID. Supply questionId to inspect its accepted reply and separate worker acknowledgement. Reconnect never resubmits work or resets deadlines. Recovery after parent exit is evidence only, not continuing enforcement. Same-task restart is refused; completed-task follow-up uses subagent_follow_up.',
    parameters: Type.Object({ taskId: Type.String(), questionId: Type.Optional(Type.String()) }),
    execute(_id, parameters, _signal, _update, context) {
      const parentSessionId = context.sessionManager.getSessionId();
      const active = getController();
      const receipt = parameters.questionId
        ? active.questionReceipt(parameters.taskId, parentSessionId, parameters.questionId)
        : undefined;
      const status = {
        ...active.status(parameters.taskId, parentSessionId),
        questionReceipt: receipt,
      };

      return Promise.resolve({
        content: [{ type: 'text' as const, text: JSON.stringify(status) }],
        details: status,
      });
    },
  });
  pi.registerTool({
    name: 'subagent_reply',
    label: 'Reply to worker',
    description:
      'Answer one pending clarification for an active owned worker. Confirm the reply stays within its assigned scope. Scope increases are refused. Acceptance and herdr text delivery are not worker acknowledgement or applied effects. Repeated calls never resend an accepted reply; inspect status after uncertain delivery.',
    parameters: Type.Object(
      {
        taskId: Type.String(),
        questionId: Type.String(),
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
