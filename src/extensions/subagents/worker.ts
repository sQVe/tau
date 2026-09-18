// Running-child settlement adapted from pi-interactive-subagents c3e8b53, subagent-done.ts. See LICENSE.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { processExists } from './cancellation.js';
import { checkWorkerRuntime } from './loadout.js';
import { workerPrompt } from './profiles.js';
import {
  acceptAcknowledgement,
  acceptQuestion,
  acceptReport,
  readEvent,
  readReply,
  readRecord,
  readTask,
  recordEvent,
  validateQuestion,
} from './records.js';
import type { Question, Task } from './types.js';

const parentRunning = (processId: number): boolean => {
  try {
    return processExists(processId);
  } catch {
    // Errors such as EPERM do not prove that the parent exited.
    return true;
  }
};

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
  let pendingQuestion: Question | undefined;
  let parentWatch: ReturnType<typeof setInterval> | undefined;
  const children = () => {
    const state = { active: 0, uncertain: [] as string[] };
    pi.events.emit('tau:worker-children', state);

    return state;
  };
  const removeNotificationListener = pi.events.on('tau:child-notification', (value: unknown) => {
    if (
      !task ||
      !accepted ||
      reported ||
      settled ||
      !value ||
      typeof value !== 'object' ||
      !('message' in value) ||
      typeof value.message !== 'string'
    ) {
      return;
    }
    // A child result is evidence, never a reply to this worker's pending parent question.
    pi.sendMessage(
      { customType: 'tau-worker-child', content: value.message, display: true },
      pendingQuestion ? { deliverAs: 'nextTurn' } : { deliverAs: 'followUp', triggerTurn: true },
    );
  });

  pi.registerTool({
    name: 'subagent_question',
    label: 'Ask parent',
    description:
      'Ask the parent one clarification and pause this turn without exiting. Waiting uses the original deadline. This does not authorize increased scope. Call alone.',
    parameters: Type.Object(
      { question: Type.String({ minLength: 1, maxLength: 32000 }) },
      { additionalProperties: false },
    ),
    execute(_id, parameters, _signal, _update, context) {
      if (!task || !accepted || settled || reported || pendingQuestion) {
        throw new Error('This worker has no active task available for a question.');
      }
      // oxlint-disable-next-line node/no-process-env -- The parent binds its process identity through the pane environment.
      const parentProcess = Number(process.env.TAU_PARENT_PROCESS);
      if (!Number.isSafeInteger(parentProcess) || parentProcess <= 0) {
        throw new Error('This worker has no parent process to ask.');
      }

      const question = validateQuestion(
        {
          version: 1,
          taskId: task.taskId,
          questionId: randomUUID(),
          question: parameters.question,
        },
        task.taskId,
      );

      // Keep waiting after uncertain publication rather than generate another question identity.
      pendingQuestion = question;
      // A closed or exited parent cannot reply, so waiting would keep this worker open forever.
      // Start watching before publication so an uncertain save still ends the wait.
      // ponytail: PID reuse can hide parent exit; compare process start times if that shows up.
      parentWatch = setInterval(() => {
        if (
          !task ||
          !pendingQuestion ||
          settled ||
          (parentRunning(parentProcess) && !readEvent(directory, task.taskId, 'parentClosed'))
        ) {
          return;
        }
        clearInterval(parentWatch);
        settled = true;
        try {
          recordEvent(
            directory,
            task.taskId,
            'settled',
            'Parent closed or exited while this worker waited for a reply. No reply can arrive.',
            true,
          );
        } finally {
          context.shutdown();
        }
      }, 1000);
      acceptQuestion(directory, task.taskId, question);

      return Promise.resolve({
        content: [
          {
            type: 'text' as const,
            text: 'Question saved for the parent. Wait for a validated reply; do not continue or assume an answer.',
          },
        ],
        details: pendingQuestion,
        terminate: true,
      });
    },
  });

  pi.on('input', (event, context) => {
    if (!accepted && event.source === 'extension') {
      return { action: 'continue' };
    }

    try {
      if (
        !task ||
        !accepted ||
        settled ||
        reported ||
        !pendingQuestion ||
        context.sessionManager.getSessionId() !== task.nativeSessionId ||
        context.sessionManager.getSessionFile() !== task.nativeSessionFile
      ) {
        return { action: 'handled' };
      }

      const reply = readReply(directory, task.taskId, pendingQuestion.questionId);
      if (!reply) {
        return { action: 'handled' };
      }

      const reference = {
        version: 1,
        taskId: task.taskId,
        questionId: pendingQuestion.questionId,
        replyId: reply.replyId,
      };
      if (event.text !== `TAU_REPLY ${JSON.stringify(reference)}`) {
        return { action: 'handled' };
      }

      acceptAcknowledgement(directory, task.taskId, reference);
      pendingQuestion = undefined;
      clearInterval(parentWatch);

      return {
        action: 'transform',
        text: `Parent clarification for the original task only. Scope, safety settings and deadline are unchanged.\n\n${reply.reply}`,
      };
    } catch (error) {
      context.ui.notify(`Reply refused: ${String(error)}. No automatic retry.`, 'error');

      return { action: 'handled' };
    }
  });

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
      const descendants = children();
      if (descendants.active) {
        throw new Error(
          'Active children remain. Wait for completion or request bounded cancellation before reporting.',
        );
      }
      const report = acceptReport(directory, task.taskId, {
        ...parameters,
        summary: [parameters.summary, ...descendants.uncertain].join('\n'),
        taskId: task.taskId,
      });
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
            'Native continuation by restarting an accepted task is refused. A new follow-up requires final handover and confirmed parent cleanup.',
          );
        }
        context.shutdown();
        return;
      }
      // Only the parent enforces the task deadline; wall-clock records are for display and recovery.
      await checkWorkerRuntime(task.loadout, pi, context);
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
    removeNotificationListener();
    clearInterval(kickoff);
    clearInterval(parentWatch);
  });

  pi.on('agent_start', () => {
    if (!task || accepted) {
      return;
    }
    recordEvent(directory, task.taskId, 'accepted', 'Pi started the assigned task.');
    accepted = true;
  });
  pi.on('tool_call', (event, context) => {
    if (!accepted || settled || reported || !task || pendingQuestion) {
      return {
        block: true,
        reason: 'Worker task is inactive or waiting for a parent reply.',
        terminate: true,
      };
    }
    // The bundled questionnaire reconciler may restore this tool each turn. Workers must ask the parent instead.
    if (event.toolName === 'ask_user_question') {
      return {
        block: true,
        reason:
          'Use subagent_question to ask the parent. Direct worker questionnaires are unavailable.',
      };
    }
    if (event.toolName !== 'subagent_report' && event.toolName !== 'subagent_question') {
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
      return { block: true, reason: `Call ${event.toolName} alone after all other tools finish.` };
    }

    return undefined;
  });
  pi.on('agent_settled', (_event, context) => {
    if (!task || !accepted || settled || pendingQuestion || children().active > 0) {
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
