import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { parseJson } from '../command.js';
import { errorMessage } from '../errors.js';
import { describeSchemaProblem, isRecord } from '../schema.js';

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

export class HcError extends Error {
  override name = 'HcError';
  readonly kind: string;
  readonly hint: string | undefined;
  readonly exitCode: number | undefined;

  constructor(kind: string, message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.kind = kind;
    this.hint = options.hint;
    this.exitCode = options.exitCode;
  }
}

const statusSchema = Type.Object({
  state: Type.String(),
  app: Type.Optional(Type.String()),
  kind: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  msg: Type.Optional(Type.String()),
  progress: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  title: Type.Optional(Type.String()),
});

const foregroundSchema = Type.Object({
  pid: Type.Number(),
  name: Type.String(),
  argv: Type.Array(Type.String()),
  cwd: Type.String(),
});

const hcTerminalSchema = Type.Object({
  address: Type.String(),
  state: Type.String(),
  foreground: Type.Optional(Type.Union([foregroundSchema, Type.Null()])),
  labels: Type.Optional(Type.Record(Type.String(), Type.String())),
  argv: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()),
  created_ms: Type.Optional(Type.Number()),
  screen: Type.Optional(Type.String()),
  cols: Type.Optional(Type.Number()),
  rows: Type.Optional(Type.Number()),
  parent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  status: Type.Optional(Type.Union([statusSchema, Type.String(), Type.Null()])),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const hcTerminalListSchema = Type.Object({
  terminals: Type.Array(hcTerminalSchema),
});

const hcWaitResultSchema = Type.Cyclic(
  {
    WaitResult: Type.Object({
      terminal: Type.String(),
      ended: Type.Boolean(),
      reason: Type.String(),
      turn: Type.Number(),
      children: Type.Array(Type.Ref('WaitResult')),
      exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      signal: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      from: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  },
  'WaitResult',
);

const hcSendResultSchema = Type.Object({
  turn: Type.Number(),
  started: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  wait: Type.Optional(Type.Union([hcWaitResultSchema, Type.Null()])),
});

const hcRemoveResultSchema = Type.Object({
  removed: Type.String(),
});

const coreInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
});

const helloResultSchema = Type.Object({
  generation: Type.Number(),
  version: Type.String(),
  core: coreInfoSchema,
  framed: Type.Boolean(),
  methods: Type.Array(Type.String()),
  features: Type.Array(Type.String()),
});

const commandSchemas = {
  run: hcTerminalSchema,
  get: hcTerminalSchema,
  ls: hcTerminalListSchema,
  send: hcSendResultSchema,
  wait: hcWaitResultSchema,
  kill: hcTerminalSchema,
  rm: hcRemoveResultSchema,
  label: hcTerminalSchema,
} as const;

export type HcCommand = keyof typeof commandSchemas;

export type HcTerminal = Static<typeof hcTerminalSchema>;
export type HcTerminalList = Static<typeof hcTerminalListSchema>;
export type HcSendResult = Static<typeof hcSendResultSchema>;
export type HcWaitResult = Static<typeof hcWaitResultSchema>;
export type HcRemoveResult = Static<typeof hcRemoveResultSchema>;
export type HelloResult = Static<typeof helloResultSchema>;
export type HcCommandReply<Command extends HcCommand> = Static<(typeof commandSchemas)[Command]>;

const checkSchema = <Schema extends TSchema>(
  label: string,
  schema: Schema,
  value: unknown,
): Static<Schema> => {
  if (!Value.Check(schema, value)) {
    throw new HcError(
      'unexpected',
      `${label} printed unexpected output: ${describeSchemaProblem(schema, value)}`,
    );
  }

  // oxlint-disable-next-line typescript/no-unsafe-return -- the generic schema type cannot narrow the checked value.
  return value;
};

const parseReplyJson = (label: string, text: string): unknown => {
  try {
    return parseJson(label, text);
  } catch (error) {
    throw new HcError('malformed', errorMessage(error));
  }
};

const jsonRpcError = (label: string, value: unknown): HcError => {
  const record = isRecord(value) ? value : {};
  const data = isRecord(record.data) ? record.data : {};
  const kind = typeof data.kind === 'string' ? data.kind : 'failed';

  const message =
    typeof record.message === 'string' ? record.message : `${label} returned an error`;

  const hint = typeof data.hint === 'string' ? data.hint : undefined;

  return new HcError(kind, message, hint === undefined ? {} : { hint });
};

export const parseCommandReply = <Command extends HcCommand>(
  label: string,
  command: Command,
  stdout: string,
): Static<(typeof commandSchemas)[Command]> =>
  checkSchema(label, commandSchemas[command], parseReplyJson(label, stdout));

export const parseCliError = (label: string, stderr: string, exitCode: number): HcError => {
  let value: unknown;

  try {
    value = JSON.parse(stderr);
  } catch {
    const output = stderr.trim();

    return new HcError('failed', `${label} failed: ${output === '' ? 'no output' : output}`, {
      exitCode,
    });
  }

  const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
  const kind = typeof error?.kind === 'string' ? error.kind : 'failed';
  const message = typeof error?.message === 'string' ? error.message : `${label} failed`;
  const hint = typeof error?.hint === 'string' ? error.hint : undefined;

  return new HcError(kind, message, { ...(hint === undefined ? {} : { hint }), exitCode });
};

export const parseJsonRpcReplies = (
  label: string,
  lines: readonly string[],
): Record<string, unknown>[] =>
  lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value = parseReplyJson(label, line);

      if (!isRecord(value)) {
        throw new HcError('malformed', `${label} printed a reply that is not an object`);
      }

      return value;
    });

const hasId = (value: Record<string, unknown>): boolean => 'id' in value;

export const matchParsedReply = (
  label: string,
  replies: readonly Record<string, unknown>[],
  id: number,
): unknown => {
  if (!replies.every(hasId)) {
    throw new HcError('malformed', `${label} printed a reply without an id`);
  }

  const reply = replies.find((value) => value.id === id);

  if (reply === undefined) {
    return undefined;
  }

  if ('error' in reply) {
    throw jsonRpcError(label, reply.error);
  }

  if (!('result' in reply)) {
    throw new HcError('malformed', `${label} printed reply ${id} without a result`);
  }

  return reply.result;
};

export const requestLine = (id: number, method: string, params: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

export const parseTerminal = (label: string, value: unknown): HcTerminal =>
  checkSchema(label, hcTerminalSchema, value);

export const parseHelloResult = (label: string, value: unknown): HelloResult =>
  checkSchema(label, helloResultSchema, value);
