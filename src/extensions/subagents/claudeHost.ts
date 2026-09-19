// Keep task state in the parent; claudeChannel.ts only relays requests and handles transport failures.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { resolve } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { endedKinds } from './admission.js';
import { processExists } from './cancellation.js';
import { claudeToolName, claudeDeniedTools, probeSafetyIntegration } from './claude.js';
import { claudeIntegrationFingerprint } from './loadout.js';
import {
  acceptAcknowledgement,
  acceptQuestion,
  acceptReport,
  readEvent,
  readPendingQuestion,
  readRecord,
  readReply,
  readReport,
  recordEvent,
  validateQuestion,
} from './records.js';
import { isClaudeLoadout, textLimit } from './types.js';
import type { Task } from './types.js';

export interface ChannelTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ClaudeChannelOptions {
  directory: string;
  task: Task;
  socketPath: string;
  // Nested delegation tools stay with the controller that owns admission, placement, and cancellation.
  delegation?: () => ChannelTool[];
  children?: () => { active: number; uncertain: string[] };
}

interface HookDecision {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const hookMessageSchema = Type.Object({
  kind: Type.Union([Type.Literal('hook'), Type.Literal('mcp')]),
  event: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // An unusable process identity stays readable here so the startup check can name it.
  claudePid: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  claude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
const sessionStartSchema = Type.Object({
  session_id: Type.String({ minLength: 1 }),
  transcript_path: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  source: Type.Optional(Type.String()),
});
const promptSchema = Type.Object({
  session_id: Type.String({ minLength: 1 }),
  prompt: Type.String(),
  permission_mode: Type.Optional(Type.String()),
});
const toolSchema = Type.Object({
  session_id: Type.String({ minLength: 1 }),
  tool_name: Type.Optional(Type.String()),
});
const requestSchema = Type.Object({
  method: Type.Optional(Type.String()),
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const reportSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal('success'),
    Type.Literal('failure'),
    Type.Literal('incomplete'),
  ]),
  summary: Type.String({ minLength: 1, maxLength: textLimit }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: textLimit }), { maxItems: 100 }),
});
const questionToolSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: textLimit }),
});

const block = (reason: string): HookDecision => ({ stderr: reason, exitCode: 2 });
const deny = (reason: string): HookDecision => ({
  // Return a tool denial that Claude can show to the worker, rather than a transport error.
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
  exitCode: 0,
});
const allow = (): HookDecision => ({ exitCode: 0 });

const processRunning = (processId: number): boolean => {
  try {
    return processExists(processId);
  } catch {
    // Errors such as EPERM do not prove that the worker exited.
    return true;
  }
};

const startupMismatch = (
  payload: { session_id: string; transcript_path: string; cwd: string; source?: string },
  task: Task,
  loadout: { cwd: string; integrations: string[]; integrationFingerprint: string },
  claudePid: number | undefined,
): string | undefined => {
  const expectedSource = task.predecessorTaskId ? 'resume' : 'startup';
  if (payload.source !== undefined && payload.source !== expectedSource) {
    return `Claude started this task from ${payload.source}, not ${expectedSource}.`;
  }
  if (
    payload.session_id !== task.nativeSessionId ||
    resolve(payload.transcript_path) !== resolve(task.nativeSessionFile) ||
    payload.cwd !== loadout.cwd
  ) {
    return 'Claude session identity, transcript path, or working directory does not match the saved task.';
  }
  if (!claudePid || !Number.isSafeInteger(claudePid) || !processRunning(claudePid)) {
    return 'Claude did not report a running process identity.';
  }
  if (claudeIntegrationFingerprint(loadout.integrations) !== loadout.integrationFingerprint) {
    return 'Claude worker integration source changed after resolution.';
  }

  return undefined;
};

export class ClaudeChannel {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly notices = new Map<string, string>();
  private accepted = false;
  private closed = false;
  private failed: string | undefined;

  constructor(private readonly options: ClaudeChannelOptions) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
      });
      socket.on('error', () => {
        socket.destroy();
      });
      this.serve(socket);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolved, rejected) => {
      this.server.once('error', rejected);
      this.server.listen({ path: this.options.socketPath, readableAll: false }, () => {
        this.server.removeListener('error', rejected);

        // A later accept error must not reach this parent process as an uncaught exception.
        this.server.on('error', (error: Error) => {
          this.failed = `Worker channel stopped accepting connections: ${error.message}`;
          this.close();
        });

        resolved();
      });
    });
  }

  failure(): string | undefined {
    return this.failed;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }

    this.server.close();
  }

  // The relay sends process.ppid. Compare that claim with the process recorded at readiness.
  private ownsConnection(claude: number | null | undefined): boolean {
    const { directory, task } = this.options;
    const worker = readEvent(directory, task.taskId, 'ready')?.processId;

    return Boolean(worker) && claude === worker;
  }

  notice(message: string): string {
    const noticeId = randomUUID();
    this.notices.set(noticeId, message);

    return `TAU_NOTICE ${noticeId}\n${message}`;
  }

  private serve(socket: Socket): void {
    let buffered = '';
    let relay: ((line: string) => void) | undefined;

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;

      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) {
          if (buffered.length > 4_000_000) {
            socket.destroy();
          }

          return;
        }

        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (relay) {
          relay(line);
          continue;
        }

        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          message = undefined;
        }

        if (!Value.Check(hookMessageSchema, message)) {
          // The worker-side script decides what an unusable frame means for its own event.
          socket.end(
            `${JSON.stringify({ blocked: true, stderr: 'Tau worker channel received an unusable frame.' })}\n`,
          );

          return;
        }

        if (message.kind === 'mcp') {
          // Claude connects its channel before the session start hook records readiness, so the
          // identity this connection claims is matched against that record before it runs a tool.
          // A self-reported identity is evidence a local caller must fake, not proof of ownership.
          const claude = message.claude;
          relay = (frame) => {
            void this.handleRpc(frame, socket, claude);
          };
          continue;
        }

        void this.answerHook(message, socket);

        return;
      }
    });
  }

  private async answerHook(
    message: {
      event?: string | undefined;
      payload?: Record<string, unknown> | undefined;
      claudePid?: number | null | undefined;
    },
    socket: Socket,
  ): Promise<void> {
    let decision: HookDecision;
    try {
      decision = await this.decide(message);
    } catch (error) {
      decision = block(`Tau worker channel refused this step: ${String(error)}`);
    }

    socket.end(`${JSON.stringify(decision)}\n`);
  }

  private decide(message: {
    event?: string | undefined;
    payload?: Record<string, unknown> | undefined;
    claudePid?: number | null | undefined;
  }): Promise<HookDecision> {
    const payload = message.payload ?? {};

    // Hook events settle turns and end tasks, and any local process can reach this socket, so once
    // readiness names the worker process every event needs the evidence tool calls need. Before
    // that record exists there is nothing to compare against, and each handler fails closed on the
    // saved session, transcript, and working directory instead.
    const { directory, task } = this.options;
    if (readEvent(directory, task.taskId, 'ready') && !this.ownsConnection(message.claudePid)) {
      const refusal = 'This channel belongs to another worker process.';

      return Promise.resolve(message.event === 'PreToolUse' ? deny(refusal) : block(refusal));
    }

    if (message.event === 'SessionStart') {
      return this.sessionStart(payload, message.claudePid ?? undefined);
    }
    if (message.event === 'UserPromptSubmit') {
      return Promise.resolve(this.userPrompt(payload));
    }
    if (message.event === 'PreToolUse') {
      return Promise.resolve(this.preTool(payload));
    }
    if (message.event === 'Stop') {
      return Promise.resolve(this.stop());
    }

    return Promise.resolve(allow());
  }

  private ended(): string | undefined {
    const { directory, task } = this.options;
    const event = [...endedKinds, 'continuationRefused' as const].find((kind) =>
      readEvent(directory, task.taskId, kind),
    );

    return event ? `This task already recorded ${event}.` : undefined;
  }

  private startupFailure(detail: string): HookDecision {
    const { directory, task } = this.options;
    if (!readEvent(directory, task.taskId, 'startupFailure')) {
      recordEvent(directory, task.taskId, 'startupFailure', detail);
    }

    return block(detail);
  }

  private async sessionStart(
    payload: Record<string, unknown>,
    claudePid: number | undefined,
  ): Promise<HookDecision> {
    const { directory, task } = this.options;
    const loadout = task.loadout;
    if (!isClaudeLoadout(loadout)) {
      return this.startupFailure('This worker record is not a Claude task.');
    }
    if (!Value.Check(sessionStartSchema, payload)) {
      return this.startupFailure('Claude reported an unusable session start payload.');
    }

    // Claude also reports a session start when it compacts or clears its own context, which is not a restart.
    if (payload.source !== undefined && !['startup', 'resume'].includes(payload.source)) {
      return allow();
    }
    if (readEvent(directory, task.taskId, 'accepted')) {
      if (!readEvent(directory, task.taskId, 'continuationRefused')) {
        recordEvent(
          directory,
          task.taskId,
          'continuationRefused',
          'Restarting an accepted Claude task is refused. A follow-up needs final handover and confirmed parent cleanup.',
        );
      }

      return block('This task was already accepted. Restarting it is refused.');
    }

    const mismatch = startupMismatch(payload, task, loadout, claudePid);
    if (mismatch) {
      return this.startupFailure(mismatch);
    }

    try {
      const evidence = await probeSafetyIntegration(loadout);
      recordEvent(
        directory,
        task.taskId,
        'ready',
        `Saved session, transcript, cwd, and integrations checked. ${evidence}`,
        false,
        claudePid,
      );
    } catch (error) {
      return this.startupFailure(`CC Safety Net evidence is unavailable: ${String(error)}`);
    }

    return allow();
  }

  private userPrompt(payload: Record<string, unknown>): HookDecision {
    const { directory, task } = this.options;
    const loadout = task.loadout;
    if (!isClaudeLoadout(loadout) || !Value.Check(promptSchema, payload)) {
      return block('Claude reported an unusable prompt payload.');
    }
    if (payload.session_id !== task.nativeSessionId) {
      return block('This prompt belongs to another Claude session.');
    }

    const ended = this.ended();
    if (ended) {
      return block(`${ended} No further work is authorized.`);
    }

    // The permission mode is only observable once Claude submits a turn; refuse anything but the recorded mode.
    if (payload.permission_mode !== loadout.permissionMode) {
      return this.startupFailure(
        `Claude runs with permission mode ${String(payload.permission_mode)}, not the recorded ${loadout.permissionMode}.`,
      );
    }
    if (!readEvent(directory, task.taskId, 'ready')) {
      return block('This worker has no recorded readiness evidence.');
    }
    if (!readEvent(directory, task.taskId, 'accepted')) {
      return this.acceptDispatch(payload.prompt);
    }
    if (readReport(directory, task.taskId)) {
      return block('This task already has a durable handover. Stop working.');
    }

    if (payload.prompt.startsWith('TAU_REPLY ')) {
      return this.acceptReplyDelivery(payload.prompt);
    }
    if (payload.prompt.startsWith('TAU_NOTICE ')) {
      return this.acceptNotice(payload.prompt);
    }

    return block(
      'Only the parent assigns work to this worker. Use the channel tools to ask or report.',
    );
  }

  private acceptDispatch(prompt: string): HookDecision {
    const { directory, task } = this.options;
    let dispatch: unknown;
    try {
      dispatch = readRecord(directory, 'dispatch.json');
    } catch {
      return block('This worker has no dispatched task yet.');
    }

    const expected = Value.Check(
      Type.Object({ taskId: Type.String(), prompt: Type.String() }),
      dispatch,
    )
      ? dispatch
      : undefined;
    if (!expected || expected.taskId !== task.taskId || expected.prompt !== prompt) {
      return block('This prompt is not the task the parent dispatched.');
    }

    recordEvent(directory, task.taskId, 'accepted', 'Claude submitted the dispatched task.');
    this.accepted = true;

    return allow();
  }

  private acceptReplyDelivery(prompt: string): HookDecision {
    const { directory, task } = this.options;
    const newline = prompt.indexOf('\n');
    const [, questionId = '', replyId = ''] = (
      newline === -1 ? prompt : prompt.slice(0, newline)
    ).split(' ');
    const body = newline === -1 ? '' : prompt.slice(newline + 1);
    const reply = readReply(directory, task.taskId, questionId);
    if (!reply || reply.replyId !== replyId || reply.reply !== body) {
      return block('This reply does not match an accepted parent reply for this task.');
    }

    acceptAcknowledgement(directory, task.taskId, {
      version: 1,
      taskId: task.taskId,
      questionId,
      replyId,
    });

    return allow();
  }

  private acceptNotice(prompt: string): HookDecision {
    const newline = prompt.indexOf('\n');
    const noticeId = (newline === -1 ? prompt : prompt.slice(0, newline)).slice(
      'TAU_NOTICE '.length,
    );
    const message = newline === -1 ? '' : prompt.slice(newline + 1);
    if (this.notices.get(noticeId) !== message) {
      return block('This notice was not issued by the parent controller.');
    }

    this.notices.delete(noticeId);

    return allow();
  }

  private preTool(payload: Record<string, unknown>): HookDecision {
    const { directory, task } = this.options;
    if (!Value.Check(toolSchema, payload) || payload.session_id !== task.nativeSessionId) {
      return deny('Tau could not bind this tool call to the saved worker task.');
    }
    if (payload.tool_name && claudeDeniedTools.includes(payload.tool_name)) {
      return deny(
        `${payload.tool_name} is unavailable to workers. Delegate with ${claudeToolName('subagent')} and ask the parent with ${claudeToolName('subagent_question')}.`,
      );
    }
    // The launch flags deny named tools; this is what makes the recorded loadout the whole list.
    if (payload.tool_name && !task.loadout.tools.includes(payload.tool_name)) {
      return deny(`${payload.tool_name} is not one of this worker's tools.`);
    }
    const ended = this.ended();
    if (ended) {
      return deny(`${ended} No further tool use is authorized.`);
    }
    if (!readEvent(directory, task.taskId, 'accepted')) {
      return deny('This worker has no accepted active task.');
    }
    if (readReport(directory, task.taskId)) {
      return deny('This task already has a durable handover. Stop working.');
    }

    const pending = readPendingQuestion(directory, task.taskId);
    if (pending && payload.tool_name !== claudeToolName('subagent_status')) {
      return deny('This worker is waiting for a parent reply.');
    }

    return allow();
  }

  private stop(): HookDecision {
    const { directory, task } = this.options;
    if (!this.accepted && !readEvent(directory, task.taskId, 'accepted')) {
      return allow();
    }
    if (this.ended()) {
      return allow();
    }

    // Waiting ends a turn without ending the task.
    if (
      readPendingQuestion(directory, task.taskId) ||
      (this.options.children?.().active ?? 0) > 0
    ) {
      return allow();
    }

    recordEvent(
      directory,
      task.taskId,
      'settled',
      'Claude ended its turn with no pending question or active child.',
    );

    return allow();
  }

  private tools(): ChannelTool[] {
    const { directory, task } = this.options;

    return [
      {
        name: 'subagent_report',
        description:
          'Submit the final durable handover once. Receipt does not prove correctness or stopped work. Do not retry uncertain delivery.',
        parameters: reportSchema,
        execute: (input) => {
          if (!Value.Check(reportSchema, input)) {
            throw new Error('Invalid, oversized, or wrong-task report.');
          }

          const descendants = this.options.children?.() ?? { active: 0, uncertain: [] };
          if (descendants.active) {
            throw new Error(
              'Active children remain. Wait for completion or request bounded cancellation before reporting.',
            );
          }

          const note = descendants.uncertain.join('\n');
          const kept = note ? input.evidence.slice(0, 99) : input.evidence;
          const dropped = input.evidence.length - kept.length;

          return Promise.resolve(
            acceptReport(directory, task.taskId, {
              ...input,
              evidence: note
                ? [
                    ...kept,
                    `${dropped ? `Dropped ${dropped} evidence entries for this note.\n` : ''}${note}`.slice(
                      0,
                      textLimit,
                    ),
                  ]
                : kept,
              taskId: task.taskId,
            }),
          );
        },
      },
      {
        name: 'subagent_question',
        description:
          'Ask the parent one clarification and stop working until it answers. Waiting uses the original deadline and does not authorize increased scope.',
        parameters: questionToolSchema,
        execute: (input) => {
          if (!Value.Check(questionToolSchema, input)) {
            throw new Error('Invalid worker question.');
          }

          const question = validateQuestion(
            {
              version: 1,
              taskId: task.taskId,
              questionId: randomUUID(),
              question: input.question,
            },
            task.taskId,
          );
          const accepted = acceptQuestion(directory, task.taskId, question);

          return Promise.resolve({
            ...accepted,
            waiting:
              'Question saved for the parent. End your turn and wait; do not continue or assume an answer.',
          });
        },
      },
      ...(this.options.delegation?.() ?? []),
    ];
  }

  private requireActive(tool: string): void {
    const { directory, task } = this.options;
    const ended = this.ended();
    if (ended || !readEvent(directory, task.taskId, 'accepted')) {
      throw new Error(`This worker has no accepted active task. ${ended ?? ''}`.trim());
    }
    if (readReport(directory, task.taskId)) {
      throw new Error('This task already has a durable handover.');
    }
    if (tool !== 'subagent_status' && readPendingQuestion(directory, task.taskId)) {
      throw new Error('This worker is waiting for a parent reply.');
    }
  }

  private async handleRpc(
    frame: string,
    socket: Socket,
    claude: number | null | undefined,
  ): Promise<void> {
    if (!frame.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }

    if (!Value.Check(requestSchema, message) || message.id === undefined) {
      return;
    }

    const send = (body: Record<string, unknown>) => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body })}\n`);
    };

    try {
      send({ result: await this.respond(message, claude) });
    } catch (error) {
      send({ error: { code: -32_603, message: String(error) } });
    }
  }

  private async respond(
    message: { method?: string; params?: Record<string, unknown> },
    claude: number | null | undefined,
  ): Promise<unknown> {
    const parameters = message.params ?? {};
    if (message.method === 'initialize') {
      return {
        protocolVersion:
          typeof parameters.protocolVersion === 'string'
            ? parameters.protocolVersion
            : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tau-subagents', version: '1' },
      };
    }
    if (message.method === 'ping') {
      return {};
    }
    if (message.method === 'tools/list') {
      return {
        tools: this.tools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      };
    }
    if (message.method === 'tools/call') {
      if (!this.ownsConnection(claude)) {
        throw new Error('This channel belongs to another worker process.');
      }

      const name = typeof parameters.name === 'string' ? parameters.name : '';
      const tool = this.tools().find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Unknown worker tool: ${name}`);
      }

      const input = Value.Check(Type.Record(Type.String(), Type.Unknown()), parameters.arguments)
        ? parameters.arguments
        : {};

      try {
        this.requireActive(name);
        const details = await tool.execute(input);

        return { content: [{ type: 'text', text: JSON.stringify(details) }] };
      } catch (error) {
        // A refusal belongs in the worker's transcript, not in a transport error it cannot read.
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }

    throw new Error(`Unsupported channel method: ${String(message.method)}`);
  }
}
