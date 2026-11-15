import { isRecord } from '../schema.ts';

export type Entry = Record<string, unknown>;

export interface CallResult {
  error: string | undefined;
  details: Entry | undefined;
}

export interface CalledTool {
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

// parseTranscript returns read, malformed, or missing; a file reader adds unreadable.
export type Transcript =
  | { status: 'read'; cwd: string; calls: ToolCall[] }
  | { status: 'malformed'; cwd: string | undefined; calls: ToolCall[]; reason: string }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

interface TranscriptLines {
  cwd: string | undefined;
  calls: ToolCall[];
  malformedLines: number;
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

export const assistantCalls = (message: Entry): CalledTool[] => {
  const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : [];

  return parts.flatMap((part) => {
    const tool = text(part.name);
    const callId = text(part.id);

    if (part.type !== 'toolCall' || tool === undefined || callId === undefined) {
      return [];
    }

    return [{ callId, tool, arguments: isRecord(part.arguments) ? part.arguments : undefined }];
  });
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

// Codemode saves each nested call with its arguments as JSON text and a status, without the
// result details of the tool.
export const codemodeCalls = (details: Entry, scriptCallId: string): NestedCall[] => {
  const calls = Array.isArray(details.calls) ? details.calls.filter(isRecord) : [];

  return calls.flatMap((call, index) => {
    const tool = text(call.name);

    if (tool === undefined) {
      return [];
    }

    return [
      {
        callId: text(call.id) ?? `${scriptCallId}/${index + 1}`,
        tool,
        arguments: parseEntry(text(call.args) ?? ''),
        result: nestedResult(call),
      },
    ];
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
    for (const called of assistantCalls(message)) {
      const call = { ...called, entryId, timestamp, viaCodemode: false, result: undefined };

      lines.calls.push(call);
      pending.set(call.callId, call);
    }
  }

  if (message.role === 'toolResult') {
    const { callId, result } = toolResult(message);
    const call = pending.get(callId);

    if (call !== undefined) {
      call.result = result;
    }
  }
};

const withNestedCalls = (calls: ToolCall[]): ToolCall[] =>
  calls.flatMap((call) => {
    const details = call.tool === 'codemode' ? call.result?.details : undefined;

    const nested = details === undefined ? [] : codemodeCalls(details, call.callId);

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
  const lines: TranscriptLines = { cwd: headerCwd(entries[0]), calls: [], malformedLines };
  const pending = new Map<string, ToolCall>();

  for (const entry of entries) {
    addEntry(lines, entry, pending);
  }

  const { cwd } = lines;
  const calls = withNestedCalls(lines.calls);

  if (cwd === undefined) {
    return { status: 'malformed', cwd, calls, reason: 'The first line is not a session header.' };
  }

  if (lines.malformedLines > 0) {
    return {
      status: 'malformed',
      cwd,
      calls,
      reason: `${lines.malformedLines} lines are malformed.`,
    };
  }

  return { status: 'read', cwd, calls };
};
