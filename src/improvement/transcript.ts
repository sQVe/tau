import { Type } from 'typebox';
import type { Static } from 'typebox';

import { isRecord } from '../schema.ts';

export type Entry = Record<string, unknown>;

export type Transcript =
  | { status: 'read'; cwd: string; calls: ToolCall[] }
  | { status: 'malformed'; cwd: string | undefined; calls: ToolCall[]; reason: string }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

interface DroppedCall {
  callId: string | undefined;
  tool: string | undefined;
}

interface AssistantCalls {
  calls: CalledTool[];
  dropped: DroppedCall[];
}

interface EntryUpdate {
  malformedLines: number;
  droppedCallReasons: string[];
}

const entrySchema = Type.Record(Type.String(), Type.Unknown());

const callResultProperties = {
  error: Type.Optional(Type.String()),
  details: Type.Optional(entrySchema),
};

const calledToolProperties = {
  callId: Type.String(),
  tool: Type.String(),
  arguments: Type.Optional(entrySchema),
};

const callResultSchema = Type.Object(callResultProperties, { additionalProperties: false });

const calledToolSchema = Type.Object(calledToolProperties, { additionalProperties: false });

const nestedCallSchema = Type.Object(
  { ...calledToolProperties, result: Type.Optional(callResultSchema) },
  { additionalProperties: false },
);

const toolCallSchema = Type.Object(
  {
    ...calledToolProperties,
    entryId: Type.String(),
    timestamp: Type.String(),
    viaCodemode: Type.Boolean(),
    result: Type.Optional(callResultSchema),
  },
  { additionalProperties: false },
);

export const transcriptStateSchema = Type.Object(
  {
    header: Type.Union([Type.Literal('pending'), Type.Literal('found'), Type.Literal('invalid')]),
    cwd: Type.Optional(Type.String()),
    calls: Type.Array(toolCallSchema),
    malformedLines: Type.Integer({ minimum: 0 }),
    droppedCallReasons: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type CallResult = Static<typeof callResultSchema>;

type CalledTool = Static<typeof calledToolSchema>;

export type NestedCall = Static<typeof nestedCallSchema>;

export type ToolCall = Static<typeof toolCallSchema>;

export type TranscriptState = Static<typeof transcriptStateSchema>;

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const parseEntry = (source: string): Entry | undefined => {
  try {
    const value: unknown = JSON.parse(source);

    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const parseEntries = (source: string): { entries: Entry[]; malformedLines: number } => {
  const entries: Entry[] = [];
  let malformedLines = 0;

  for (const line of source.split('\n').filter((candidate) => candidate.trim() !== '')) {
    const entry = parseEntry(line);

    if (entry === undefined) {
      malformedLines += 1;
    } else {
      entries.push(entry);
    }
  }

  return { entries, malformedLines };
};

const resultText = (content: unknown) => {
  const parts = Array.isArray(content) ? content.filter(isRecord) : [];

  return parts
    .filter((part) => part.type === 'text')
    .map((part) => text(part.text) ?? '')
    .join('\n');
};

export const assistantCalls = (message: Entry): AssistantCalls => {
  const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const found: AssistantCalls = { calls: [], dropped: [] };

  for (const part of parts.filter((candidate) => candidate.type === 'toolCall')) {
    const tool = text(part.name);
    const callId = text(part.id);

    if (tool === undefined || callId === undefined) {
      found.dropped.push({ callId, tool });
    } else {
      const parameters = isRecord(part.arguments) ? part.arguments : undefined;

      found.calls.push({
        callId,
        tool,
        ...(parameters === undefined ? {} : { arguments: parameters }),
      });
    }
  }

  return found;
};

export const toolResult = (message: Entry): { callId: string; result: CallResult } => {
  const error = message.isError === true ? resultText(message.content) : undefined;
  const details = isRecord(message.details) ? message.details : undefined;

  return {
    callId: text(message.toolCallId) ?? '',
    result: {
      ...(error === undefined ? {} : { error }),
      ...(details === undefined ? {} : { details }),
    },
  };
};

const nestedResult = (call: Entry): CallResult | undefined => {
  if (call.status === 'error') {
    return { error: text(call.error) ?? '' };
  }

  return call.status === 'ok' ? {} : undefined;
};

// Codemode cuts the args text of details.calls[] at a fixed length, and cut text does not parse.
// nestedCalls holds the whole arguments, but older results lack it.
const nestedArguments = (message: Entry) => {
  const { nestedCalls } = message;
  const listed = isRecord(nestedCalls) ? nestedCalls.calls : undefined;
  const calls = Array.isArray(listed) ? listed.filter(isRecord) : [];
  const byId = new Map<string, Entry>();

  for (const call of calls) {
    const callId = text(call.id);

    if (callId !== undefined && isRecord(call.arguments)) {
      byId.set(callId, call.arguments);
    }
  }

  return byId;
};

export const codemodeCalls = (message: Entry, scriptCallId: string): NestedCall[] => {
  const details = isRecord(message.details) ? message.details : {};
  const calls = Array.isArray(details.calls) ? details.calls.filter(isRecord) : [];
  const fullArguments = nestedArguments(message);

  return calls.flatMap((call, index) => {
    const tool = text(call.name);

    if (tool === undefined) {
      return [];
    }

    const callId = text(call.id) ?? `${scriptCallId}/${index + 1}`;

    const parameters = fullArguments.get(callId) ?? parseEntry(text(call.args) ?? '');
    const result = nestedResult(call);

    return [
      {
        callId,
        tool,
        ...(parameters === undefined ? {} : { arguments: parameters }),
        ...(result === undefined ? {} : { result }),
      },
    ];
  });
};

const latestCallIndex = (calls: readonly ToolCall[], callId: string) =>
  calls.findLastIndex((call) => call.callId === callId);

const nestedToolCall = (inner: NestedCall, call: ToolCall): ToolCall => ({
  entryId: call.entryId,
  callId: inner.callId,
  timestamp: call.timestamp,
  tool: inner.tool,
  ...(inner.arguments === undefined ? {} : { arguments: inner.arguments }),
  viaCodemode: true,
  ...(inner.result === undefined ? {} : { result: inner.result }),
});

const replaceNestedCalls = (calls: ToolCall[], index: number, call: ToolCall, message: Entry) => {
  let end = index + 1;

  while (calls[end]?.viaCodemode === true) {
    end += 1;
  }

  const nested = codemodeCalls(message, call.callId).map((inner) => nestedToolCall(inner, call));

  calls.splice(index + 1, end - index - 1, ...nested);
};

const addAssistantCalls = (
  calls: ToolCall[],
  message: Entry,
  entryId: string,
  timestamp: string,
  droppedCallReasons: string[],
) => {
  const { calls: found, dropped } = assistantCalls(message);

  for (const called of found) {
    calls.push({ ...called, entryId, timestamp, viaCodemode: false });
  }

  for (const call of dropped) {
    const named = JSON.stringify({ id: call.callId, name: call.tool });

    droppedCallReasons.push(`The tool call ${named} in entry ${entryId} has no id or name.`);
  }
};

const addToolResult = (calls: ToolCall[], message: Entry) => {
  const { callId, result } = toolResult(message);
  const index = latestCallIndex(calls, callId);
  const call = index === -1 ? undefined : calls[index];

  if (call === undefined) {
    return;
  }

  calls[index] = { ...call, result };

  if (call.tool === 'codemode' && !call.viaCodemode) {
    replaceNestedCalls(calls, index, call, message);
  }
};

const addEntry = (calls: ToolCall[], entry: Entry): EntryUpdate => {
  const message = entry.message;

  if (entry.type !== 'message' || !isRecord(message)) {
    return { malformedLines: 0, droppedCallReasons: [] };
  }

  const entryId = text(entry.id);
  const timestamp = text(entry.timestamp);

  if (entryId === undefined || timestamp === undefined) {
    return { malformedLines: 1, droppedCallReasons: [] };
  }

  const droppedCallReasons: string[] = [];

  if (message.role === 'assistant') {
    addAssistantCalls(calls, message, entryId, timestamp, droppedCallReasons);
  }

  if (message.role === 'toolResult') {
    addToolResult(calls, message);
  }

  return { malformedLines: 0, droppedCallReasons };
};

export const continueTranscript = (
  state: TranscriptState | undefined,
  chunk: string,
): TranscriptState => {
  const base: TranscriptState = state ?? {
    header: 'pending',
    calls: [],
    malformedLines: 0,
    droppedCallReasons: [],
  };

  let header = base.header;
  let cwd = base.cwd;
  let malformedLines = base.malformedLines;
  const calls = [...base.calls];
  const droppedCallReasons = [...base.droppedCallReasons];

  for (const line of chunk.split('\n').filter((candidate) => candidate.trim() !== '')) {
    const entry = parseEntry(line);

    if (entry === undefined) {
      malformedLines += 1;

      continue;
    }

    if (header === 'pending') {
      header = entry.type === 'session' ? 'found' : 'invalid';
      cwd = entry.type === 'session' ? text(entry.cwd) : undefined;
    }

    const update = addEntry(calls, entry);

    malformedLines += update.malformedLines;
    droppedCallReasons.push(...update.droppedCallReasons);
  }

  return {
    header,
    ...(cwd === undefined ? {} : { cwd }),
    calls,
    malformedLines,
    droppedCallReasons,
  };
};

export const finishTranscript = (state: TranscriptState): Transcript => {
  const cwd = state.header === 'found' ? state.cwd : undefined;

  if (cwd === undefined) {
    return {
      status: 'malformed',
      cwd,
      calls: state.calls,
      reason: 'The first line is not a session header.',
    };
  }

  const reasons = [...state.droppedCallReasons];

  if (state.malformedLines > 0) {
    reasons.unshift(`${state.malformedLines} lines are malformed.`);
  }

  if (reasons.length > 0) {
    return { status: 'malformed', cwd, calls: state.calls, reason: reasons.join(' ') };
  }

  return { status: 'read', cwd, calls: state.calls };
};

export const parseTranscript = (source: string | undefined): Transcript => {
  if (source === undefined) {
    return { status: 'missing' };
  }

  return finishTranscript(continueTranscript(undefined, source));
};
