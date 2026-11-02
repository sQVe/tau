import type { Exec } from '../src/command.js';
import type { Connect } from '../src/hc/connect.js';
import { createExecFake, failedResult, succeededResult } from './execFake.js';
import type { ExecCall } from './execFake.js';

export type HcCommand = 'run' | 'get' | 'ls' | 'send' | 'wait' | 'kill' | 'rm' | 'label';

export interface HcRequestMessage {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown;
}

interface ConnectExpectation {
  method: string;
  id: number;
  reply: { result: unknown } | { error: unknown };
}

export interface HcFake {
  exec: Exec;
  calls: ExecCall[];
  connect: Connect;
  messages: HcRequestMessage[];
  connectCalls: HcRequestMessage[][];
  reply: (command: HcCommand, stdout: string) => void;
  fail: (command: HcCommand, stderr: string, code: number) => void;
  replyConnect: (method: string, id: number, result: unknown) => void;
  failConnect: (method: string, id: number, error: unknown) => void;
  appendConnectOutput: (text: string) => void;
  setConnectExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

const commands = new Set<HcCommand>(['run', 'get', 'ls', 'send', 'wait', 'kill', 'rm', 'label']);

const isCommand = (value: string | undefined): value is HcCommand =>
  value !== undefined && commands.has(value as HcCommand);

const connectProblem = (
  call: readonly HcRequestMessage[],
  expected: readonly ConnectExpectation[],
): string | undefined => {
  if (call.length > expected.length) {
    return `unexpected connect request: ${call[expected.length]?.method ?? 'unknown'}`;
  }

  if (call.length < expected.length) {
    return `missing connect request: ${expected[call.length]?.method ?? 'unknown'}`;
  }

  for (const [index, message] of call.entries()) {
    const expectation = expected[index];

    if (
      expectation === undefined ||
      message.method !== expectation.method ||
      message.id !== expectation.id
    ) {
      return `unexpected connect request: ${message.method}`;
    }
  }

  return undefined;
};

const replyLine = (expectation: ConnectExpectation): string => {
  if ('result' in expectation.reply) {
    return `${JSON.stringify({ jsonrpc: '2.0', id: expectation.id, result: expectation.reply.result })}\n`;
  }

  return `${JSON.stringify({ jsonrpc: '2.0', id: expectation.id, error: expectation.reply.error })}\n`;
};

export const createHcFake = (): HcFake => {
  const replies = new Map<HcCommand, string>();
  const failures = new Map<HcCommand, { stderr: string; code: number }>();

  const execFake = createExecFake<HcCommand>({
    keyOf: (command, commandArguments) => {
      if (command !== 'hc') {
        return undefined;
      }

      const [first] = commandArguments;

      return isCommand(first) ? first : undefined;
    },
    handlerFor: (key) => () => {
      const failure = failures.get(key);

      if (failure !== undefined) {
        return failedResult(failure.stderr, failure.code);
      }

      const reply = replies.get(key);

      return reply === undefined ? failedResult(`unknown command: ${key}`) : succeededResult(reply);
    },
  });

  const messages: HcRequestMessage[] = [];
  const connectCalls: HcRequestMessage[][] = [];
  const expectations: ConnectExpectation[] = [];
  let connectTail = '';
  let exitCode: number | null = 0;
  let exitSignal: NodeJS.Signals | null = null;

  const connect: Connect = (lines) => {
    const call = lines.map((line) => JSON.parse(line) as HcRequestMessage);

    connectCalls.push(call);
    messages.push(...call);

    const problem = connectProblem(call, expectations);

    if (problem !== undefined) {
      return Promise.reject(new Error(problem));
    }

    const stdout = `${expectations.map(replyLine).join('')}${connectTail}`;
    const result = { stdout, stderr: '', code: exitCode, signal: exitSignal };

    expectations.length = 0;
    connectTail = '';

    return Promise.resolve(result);
  };

  return {
    exec: execFake.exec,
    calls: execFake.calls,
    connect,
    messages,
    connectCalls,
    reply: (command, stdout) => replies.set(command, stdout),
    fail: (command, stderr, code) => failures.set(command, { stderr, code }),
    replyConnect: (method, id, result) => {
      expectations.push({ method, id, reply: { result } });
    },
    failConnect: (method, id, error) => {
      expectations.push({ method, id, reply: { error } });
    },
    appendConnectOutput: (text) => {
      connectTail += text;
    },
    setConnectExit: (code, signal = null) => {
      exitCode = code;
      exitSignal = signal;
    },
  };
};
