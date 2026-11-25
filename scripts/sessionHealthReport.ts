import {
  codemodeCalls,
  copyKey,
  parseEntries,
  text,
  toolResult,
} from '../src/improvement/transcript.ts';
import type { Entry } from '../src/improvement/transcript.ts';
import { isRecord } from '../src/schema.ts';
import { assistantCalls } from '../src/sessionMessage/sessionMessage.ts';

export type Side = 'manager' | 'worker';

export interface SessionFile {
  path: string;
  side: Side;
  text: string;
}

export interface TimeWindow {
  since: number;
  until: number;
}

export interface ToolCall {
  tool: string;
  day: string;
  side: Side;
  viaCodemode: boolean;
  arguments: Record<string, unknown> | undefined;
  details: Record<string, unknown> | undefined;
  error: string | undefined;
}

export interface HealthRule {
  tool: string;
  name: string;
  check: (calls: ToolCall[], day: string) => string | undefined;
}

interface RuleResult {
  name: string;
  failure: string | undefined;
}

interface ErrorCount {
  message: string;
  count: number;
}

export interface ToolDay {
  day: string;
  tool: string;
  calls: number;
  codemodeCalls: number;
  errors: number;
  topErrors: ErrorCount[];
  rules: RuleResult[];
}

export interface SessionHealthReport {
  window: TimeWindow;
  managerFiles: number;
  workerFiles: number;
  unreadableFiles: number;
  malformedLines: number;
  copiedEntries: number;
  days: ToolDay[];
}

export interface HealthCollection {
  window: TimeWindow;
  calls: ToolCall[];
  managerFiles: number;
  workerFiles: number;
  malformedLines: number;
  copiedEntries: number;
  seen: Set<string>;
}

interface EntryFacts {
  day: string;
  side: Side;
  pending: Map<string, ToolCall>;
}

const topErrorCount = 3;
const errorMessageLength = 120;
const ellipsis = '...';
const isoDateLength = 'YYYY-MM-DD'.length;
const percentScale = 100;

const addAssistantCalls = (collection: HealthCollection, message: Entry, facts: EntryFacts) => {
  for (const called of assistantCalls(message).calls) {
    const call: ToolCall = {
      tool: called.tool,
      day: facts.day,
      side: facts.side,
      viaCodemode: false,
      arguments: called.arguments,
      details: undefined,
      error: undefined,
    };

    collection.calls.push(call);
    facts.pending.set(called.callId, call);
  }
};

const addResult = (collection: HealthCollection, message: Entry, facts: EntryFacts) => {
  const { callId, result } = toolResult(message);
  const call = facts.pending.get(callId);

  if (call === undefined) {
    return;
  }

  call.details = result.details;

  if (result.error !== undefined) {
    call.error = result.error;
  }

  if (call.tool !== 'codemode' || result.details === undefined) {
    return;
  }

  for (const nested of codemodeCalls(message, callId)) {
    collection.calls.push({
      tool: nested.tool,
      day: call.day,
      side: call.side,
      viaCodemode: true,
      arguments: nested.arguments,
      details: undefined,
      error: nested.result?.error,
    });
  }
};

const isInWindow = (collection: HealthCollection, time: number) =>
  time >= collection.window.since && time < collection.window.until;

const isCopy = (collection: HealthCollection, entry: Entry, time: number) => {
  const key = copyKey(entry);
  const copied = collection.seen.has(key);

  collection.seen.add(key);

  if (copied && isInWindow(collection, time)) {
    collection.copiedEntries += 1;
  }

  return copied;
};

export const collectSessionFile = (collection: HealthCollection, file: SessionFile): void => {
  const pending = new Map<string, ToolCall>();

  if (file.side === 'manager') {
    collection.managerFiles += 1;
  } else {
    collection.workerFiles += 1;
  }

  const { entries, malformedLines } = parseEntries(file.text);

  collection.malformedLines += malformedLines;

  for (const entry of entries) {
    const time = Date.parse(text(entry.timestamp) ?? '');

    if (Number.isNaN(time)) {
      collection.malformedLines += 1;

      continue;
    }

    const message = entry.message;

    if (isCopy(collection, entry, time) || !isRecord(message)) {
      continue;
    }

    const facts = {
      day: new Date(time).toISOString().slice(0, isoDateLength),
      side: file.side,
      pending,
    };

    // A result after the window still completes a call inside it; one before it finds no call.
    if (message.role === 'toolResult') {
      addResult(collection, message, facts);
    } else if (message.role === 'assistant' && isInWindow(collection, time)) {
      addAssistantCalls(collection, message, facts);
    }
  }
};

const normalizeError = (error: string) => {
  const message = error
    .replaceAll(/\d+(?:[,.]\d+)*/g, 'N')
    .replaceAll(/\s+/g, ' ')
    .trim();

  return message.length > errorMessageLength
    ? `${message.slice(0, errorMessageLength - ellipsis.length)}${ellipsis}`
    : message;
};

const topErrors = (calls: ToolCall[]): ErrorCount[] => {
  const counts = new Map<string, number>();

  for (const call of calls) {
    if (call.error !== undefined) {
      const message = normalizeError(call.error);

      counts.set(message, (counts.get(message) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([message, count]) => ({ message, count }))
    .toSorted(
      (left, right) => right.count - left.count || left.message.localeCompare(right.message),
    )
    .slice(0, topErrorCount);
};

const toolDay = (day: string, tool: string, calls: ToolCall[], rules: HealthRule[]): ToolDay => ({
  day,
  tool,
  calls: calls.length,
  codemodeCalls: calls.filter((call) => call.viaCodemode).length,
  errors: calls.filter((call) => call.error !== undefined).length,
  topErrors: topErrors(calls),
  rules: rules
    .filter((rule) => rule.tool === tool)
    .map((rule) => ({ name: rule.name, failure: rule.check(calls, day) })),
});

const groupKey = (day: string, tool: string) => `${day}\0${tool}`;

const summarizeDays = (calls: ToolCall[], rules: HealthRule[]): ToolDay[] => {
  const groups = new Map<string, ToolCall[]>();

  for (const day of new Set(calls.map((call) => call.day))) {
    for (const rule of rules) {
      groups.set(groupKey(day, rule.tool), []);
    }
  }

  for (const call of calls) {
    const key = groupKey(call.day, call.tool);
    const group = groups.get(key) ?? [];

    group.push(call);
    groups.set(key, group);
  }

  return [...groups]
    .map(([key, group]) => {
      const [day = '', tool = ''] = key.split('\0');

      return toolDay(day, tool, group, rules);
    })
    .toSorted(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        right.calls - left.calls ||
        left.tool.localeCompare(right.tool),
    );
};

export const createHealthCollection = (window: TimeWindow): HealthCollection => ({
  window,
  calls: [],
  managerFiles: 0,
  workerFiles: 0,
  malformedLines: 0,
  copiedEntries: 0,
  seen: new Set(),
});

export const sessionHealthReport = (
  collection: HealthCollection,
  facts: { rules: HealthRule[]; unreadableFiles: number },
): SessionHealthReport => ({
  window: collection.window,
  managerFiles: collection.managerFiles,
  workerFiles: collection.workerFiles,
  unreadableFiles: facts.unreadableFiles,
  malformedLines: collection.malformedLines,
  copiedEntries: collection.copiedEntries,
  days: summarizeDays(collection.calls, facts.rules),
});

const formatNumber = (value: number) => value.toLocaleString('en-US');

const percent = (part: number, whole: number) =>
  whole === 0 ? '-' : `${Math.round((part / whole) * percentScale)}%`;

const table = (headings: string[], rows: string[][]) => {
  const all = [headings, ...rows];

  const widths = headings.map((_, column) =>
    Math.max(...all.map((row) => row[column]?.length ?? 0)),
  );

  const pad = (row: string[]) =>
    row
      .map((cell, column) => {
        const width = widths[column] ?? 0;

        return /^[\d,%-]+$/.test(cell) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return all.map(pad);
};

const ruleCell = (row: ToolDay) => {
  if (row.rules.length === 0) {
    return 'none';
  }

  const failed = row.rules.filter((rule) => rule.failure !== undefined).map((rule) => rule.name);

  return failed.length === 0 ? 'hold' : `fail: ${failed.join(', ')}`;
};

const failureLines = (report: SessionHealthReport) => {
  const lines = report.days.flatMap((row) =>
    row.rules.flatMap((rule) =>
      rule.failure === undefined ? [] : [`${row.day}  ${row.tool} ${rule.name}: ${rule.failure}`],
    ),
  );

  return lines.length === 0 ? ['None'] : lines;
};

const dayLines = (day: string, rows: ToolDay[]) => {
  const cells = rows.map((row) => [
    row.tool,
    formatNumber(row.calls),
    formatNumber(row.codemodeCalls),
    formatNumber(row.errors),
    percent(row.errors, row.calls),
    ruleCell(row),
  ]);

  const [heading = '', ...body] = table(
    ['tool', 'calls', 'codemode', 'errors', 'error rate', 'rules'],
    cells,
  );

  const lines = ['', day, heading];

  for (const [index, line] of body.entries()) {
    lines.push(line);

    for (const error of rows[index]?.topErrors ?? []) {
      lines.push(`    ${formatNumber(error.count)}x ${error.message}`);
    }
  }

  return lines;
};

export const formatSessionHealthReport = (report: SessionHealthReport): string => {
  const since = new Date(report.window.since).toISOString();
  const until = new Date(report.window.until).toISOString();
  const files = `${formatNumber(report.managerFiles)} manager and ${formatNumber(report.workerFiles)} worker session files`;

  const counts = [
    files,
    `${formatNumber(report.unreadableFiles)} unreadable`,
    `${formatNumber(report.malformedLines)} malformed lines skipped`,
    `${formatNumber(report.copiedEntries)} copied entries counted once`,
  ].join(', ');

  const days = [...new Set(report.days.map((row) => row.day))];

  const dayTables = days.flatMap((day) =>
    dayLines(
      day,
      report.days.filter((row) => row.day === day),
    ),
  );

  return [
    `Session health from ${since} to ${until}, by UTC day`,
    counts,
    '',
    'Failed rules',
    ...failureLines(report),
    ...dayTables,
    '',
  ].join('\n');
};
