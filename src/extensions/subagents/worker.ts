import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { checkWorkerRuntime } from './loadout.js';
import { workerPrompt } from './profiles.js';
import { acceptReport, readEvent, readRecord, readTask, recordEvent } from './records.js';
import type { Task } from './types.js';

export default function workerExtension(pi: ExtensionAPI): void {
  // oxlint-disable-next-line node/no-process-env -- The parent binds this process to its saved task through the pane environment.
  const directory = process.env.TAU_WORKER_RECORD;
  if (!directory) {
    return;
  }
  let task: Task | undefined;
  let accepted = false;
  let reported = false;
  let settled = false;
  let kickoff: ReturnType<typeof setInterval> | undefined;

  pi.registerTool({
    name: 'subagent_report',
    label: 'Worker report',
    description:
      'Submit the final durable handover once. Receipt does not prove correctness or stopped work. Do not retry uncertain delivery.',
    parameters: Type.Object({
      outcome: StringEnum(['success', 'failure', 'incomplete']),
      summary: Type.String({ minLength: 1, maxLength: 32_000 }),
      evidence: Type.Array(Type.String({ minLength: 1, maxLength: 32_000 }), { maxItems: 100 }),
    }),
    execute(_id, parameters) {
      if (!task || !accepted || settled || reported) {
        throw new Error('This worker has no accepted active task.');
      }
      const report = acceptReport(directory, task.taskId, { ...parameters, taskId: task.taskId });
      reported = true;

      return Promise.resolve({
        content: [{ type: 'text' as const, text: 'Handover durably accepted. Stop working.' }],
        details: report,
        terminate: true,
      });
    },
  });

  pi.on('session_start', async (_event, context) => {
    try {
      task = readTask(directory);
      if (
        context.sessionManager.getSessionId() !== task.nativeSessionId ||
        context.sessionManager.getSessionFile() !== task.nativeSessionFile
      ) {
        throw new Error('Worker native session does not match its task.');
      }
      if (readEvent(directory, task.taskId, 'accepted')) {
        if (!readEvent(directory, task.taskId, 'continuationRefused')) {
          recordEvent(
            directory,
            task.taskId,
            'continuationRefused',
            'Native continuation is not supported. The original outcome is unchanged.',
          );
        }
        context.shutdown();
        return;
      }
      if (Date.now() >= task.deadline - task.cancellationBudget) {
        throw new Error('The original task deadline has expired.');
      }
      const readinessSignal = AbortSignal.timeout(
        Math.max(1, task.deadline - task.cancellationBudget - Date.now()),
      );
      await checkWorkerRuntime(task.loadout, pi, context, readinessSignal);
      recordEvent(
        directory,
        task.taskId,
        'ready',
        'Saved model, tools, cwd, and CC Safety Net checked.',
        false,
        process.pid,
      );
      kickoff = setInterval(() => {
        if (!task) {
          return;
        }
        if (Date.now() >= task.deadline - task.cancellationBudget) {
          clearInterval(kickoff);
          context.shutdown();
          return;
        }
        if (!existsSync(join(directory, 'dispatch.json'))) {
          return;
        }
        clearInterval(kickoff);
        try {
          const dispatch = readRecord(directory, 'dispatch.json');
          if (
            !dispatch ||
            typeof dispatch !== 'object' ||
            !('taskId' in dispatch) ||
            dispatch.taskId !== task.taskId
          ) {
            throw new Error('Invalid task dispatch.');
          }
          pi.sendUserMessage(workerPrompt(task));
        } catch (error) {
          recordEvent(directory, task.taskId, 'startupFailure', String(error));
          context.shutdown();
        }
      }, 50);
    } catch (error) {
      if (task && !readEvent(directory, task.taskId, 'startupFailure')) {
        recordEvent(directory, task.taskId, 'startupFailure', String(error));
      }
      context.ui.notify(`Worker refused: ${String(error)}`, 'error');
      context.shutdown();
    }
  });

  pi.on('session_shutdown', () => {
    clearInterval(kickoff);
  });

  pi.on('agent_start', () => {
    if (!task || accepted) {
      return;
    }
    recordEvent(directory, task.taskId, 'accepted', 'Pi started the assigned task.');
    accepted = true;
  });
  pi.on('tool_call', (event, context) => {
    if (
      !accepted ||
      settled ||
      reported ||
      !task ||
      Date.now() >= task.deadline - task.cancellationBudget
    ) {
      return {
        block: true,
        reason: 'Worker task is inactive or its work budget expired.',
        terminate: true,
      };
    }
    if (event.toolName !== 'subagent_report') {
      return undefined;
    }
    const assistant = context.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    if (
      assistant?.type !== 'message' ||
      assistant.message.role !== 'assistant' ||
      assistant.message.content.filter((block) => block.type === 'toolCall').length !== 1
    ) {
      return { block: true, reason: 'Call subagent_report alone after all other tools finish.' };
    }

    return undefined;
  });
  pi.on('agent_settled', (_event, context) => {
    if (!task || !accepted || settled) {
      return;
    }
    settled = true;
    recordEvent(
      directory,
      task.taskId,
      'settled',
      'Pi has no active run or queued continuation.',
      true,
    );
    context.shutdown();
  });
}
