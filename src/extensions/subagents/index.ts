/* oxlint-disable node/no-process-env -- Worker ownership and herdr connection come from the active Pi process. */
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { WorkerController } from './controller.js';
import { resolveLoadout } from './loadout.js';

export default function subagentsExtension(pi: ExtensionAPI): void {
  let controller: WorkerController | undefined;
  const getController = () => {
    if (process.env.TAU_WORKER_RECORD) {
      throw new Error('Nested workers are not supported.');
    }
    controller ??= new WorkerController(
      join(getAgentDir(), 'tau', 'workers'),
      undefined,
      (message) => {
        pi.sendMessage(
          { customType: 'tau-worker', content: message, display: true },
          { deliverAs: 'nextTurn' },
        );
      },
    );

    return controller;
  };
  pi.on('session_shutdown', () => {
    controller?.close();
    controller = undefined;
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Launch Pi worker',
    description:
      'Launch a trusted full-tool Pi investigator or editing worker in herdr. Requires user authorization and CC Safety Net. Fresh context, fixed parent-owned timeout, no automatic retry. Built-in profiles: investigator and worker. Set model explicitly or TAU_SUBAGENT_MODEL. Other harnesses and nested workers refuse.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 32_000 }),
      profile: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      harness: Type.Optional(Type.String()),
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
      const loadout = await resolveLoadout(parameters, context, pi, resolutionSignal);
      signal?.throwIfAborted();
      const status = await active.launch(
        {
          task: parameters.task,
          loadout,
          timeout,
          startedAt,
          parentSession,
          parentSessionId: context.sessionManager.getSessionId(),
          parentPane,
        },
        signal,
      );

      return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status };
    },
  });
  pi.registerTool({
    name: 'subagent_status',
    label: 'Worker status',
    description:
      'Recover validated task results and native references by task ID. Reconnect never resubmits work or resets deadlines. Recovery after parent exit is evidence only, not continuing enforcement. Native continuation is unsupported.',
    parameters: Type.Object({ taskId: Type.String() }),
    execute(_id, parameters, _signal, _update, context) {
      const status = getController().status(
        parameters.taskId,
        context.sessionManager.getSessionId(),
      );

      return Promise.resolve({
        content: [{ type: 'text' as const, text: JSON.stringify(status) }],
        details: status,
      });
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
