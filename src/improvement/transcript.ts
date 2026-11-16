import { isRecord } from '../schema.ts';

export type Entry = Record<string, unknown>;

export interface CallResult {
  error: string | undefined;
  details: Entry | undefined;
}

interface CalledTool {
  callId: string;
  tool: string;
  arguments: Entry | undefined;
}

export interface NestedCall extends CalledTool {
  result: CallResult | undefined;
}

export interface ToolCall extends CalledTool {
  entryId: string;
  timestamp: string;
  viaCodemode: boolean;
  result: CallResult | undefined;
}

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

interface TranscriptLines {
  cwd: string | undefined;
  calls: ToolCall[];
  nested: Map<string, NestedCall[]>;
  malformedLines: number;
  droppedCallReasons: string[];
}

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

      found.calls.push({ callId, tool, arguments: parameters });
    }
  }

  return found;
};

export const toolResult = (message: Entry): { callId: string; result: CallResult } => ({
  callId: text(message.toolCallId) ?? '',
  result: {
    error: message.isError === true ? resultText(message.content) : undefined,
    details: isRecord(message.details) ? message.details : undefined,
  },
});

const nestedResult = (call: Entry): CallResult | undefined => {
  if (call.status === 'error') {
    return { error: text(call.error) ?? '', details: undefined };
  }

  return call.status === 'ok' ? { error: undefined, details: undefined } : undefined;
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

    return [{ callId, tool, arguments: parameters, result: nestedResult(call) }];
  });
};

const headerCwd = (entry: Entry | undefined) =>
  entry?.type === 'session' ? text(entry.cwd) : undefined;

const addEntry = (lines: TranscriptLines, entry: Entry, pending: Map<string, ToolCall>) => {
  const message = entry.message;

  if (entry.type !== 'message' || !isRecord(message)) {
    return;
  }

  const entryId = text(entry.id);
  const timestamp = text(entry.timestamp);

  if (entryId === undefined || timestamp === undefined) {
    lines.malformedLines += 1;

    return;
  }

  if (message.role === 'assistant') {
    const { calls, dropped } = assistantCalls(message);

    for (const called of calls) {
      const call = { ...called, entryId, timestamp, viaCodemode: false, result: undefined };

      lines.calls.push(call);
      pending.set(call.callId, call);
    }

    for (const call of dropped) {
      const named = JSON.stringify({ id: call.callId, name: call.tool });

      lines.droppedCallReasons.push(
        `The tool call ${named} in entry ${entryId} has no id or name.`,
      );
    }
  }

  if (message.role === 'toolResult') {
    const { callId, result } = toolResult(message);
    const call = pending.get(callId);

    if (call !== undefined) {
      call.result = result;
    }

    if (call?.tool === 'codemode') {
      lines.nested.set(callId, codemodeCalls(message, callId));
    }
  }
};

const withNestedCalls = (lines: TranscriptLines): ToolCall[] =>
  lines.calls.flatMap((call) => {
    const nested = lines.nested.get(call.callId) ?? [];

    const placed = nested.map((inner) => ({
      entryId: call.entryId,
      callId: inner.callId,
      timestamp: call.timestamp,
      tool: inner.tool,
      arguments: inner.arguments,
      viaCodemode: true,
      result: inner.result,
    }));

    return [call, ...placed];
  });

export const parseTranscript = (source: string | undefined): Transcript => {
  if (source === undefined) {
    return { status: 'missing' };
  }

  const { entries, malformedLines } = parseEntries(source);

  const lines: TranscriptLines = {
    cwd: headerCwd(entries[0]),
    calls: [],
    nested: new Map(),
    malformedLines,
    droppedCallReasons: [],
  };

  const pending = new Map<string, ToolCall>();

  for (const entry of entries) {
    addEntry(lines, entry, pending);
  }

  const { cwd } = lines;
  const calls = withNestedCalls(lines);

  if (cwd === undefined) {
    return { status: 'malformed', cwd, calls, reason: 'The first line is not a session header.' };
  }

  const reasons = [...lines.droppedCallReasons];

  if (lines.malformedLines > 0) {
    reasons.unshift(`${lines.malformedLines} lines are malformed.`);
  }

  if (reasons.length > 0) {
    return { status: 'malformed', cwd, calls, reason: reasons.join(' ') };
  }

  return { status: 'read', cwd, calls };
};
