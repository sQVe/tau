import { isRecord } from '../src/schema.ts';

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
  // The UTC date of the call, such as 2026-10-01.
  day: string;
  side: Side;
  viaCodemode: boolean;
  // Undefined when the arguments are not a JSON object. Codemode cuts long arguments, which then
  // fail to parse.
  arguments: Record<string, unknown> | undefined;
  // Undefined when the log holds no result details. Codemode records none for its calls.
  details: Record<string, unknown> | undefined;
  // The error text when the call failed, otherwise undefined.
  error: string | undefined;
}

export interface HealthRule {
  tool: string;
  name: string;
  // Returns why the rule fails for one UTC day's calls of the tool, or undefined when it holds. A
  // day without calls of the tool passes an empty list.
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

type Entry = Record<string, unknown>;

const topErrorCount = 3;
const errorMessageLength = 120;
const ellipsis = '...';
const isoDateLength = 'YYYY-MM-DD'.length;
const percentScale = 100;

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

const parseObject = (source: string): Entry | undefined => {
  try {
    const value: unknown = JSON.parse(source);

    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const parseEntries = (collection: HealthCollection, source: string) => {
  const entries: Entry[] = [];

  for (const line of source.split('\n').filter((candidate) => candidate.trim() !== '')) {
    const entry = parseObject(line);

    if (entry === undefined) {
      collection.malformedLines += 1;
    } else {
      entries.push(entry);
    }
  }

  return entries;
};

const resultText = (content: unknown) => {
  const parts = Array.isArray(content) ? content.filter(isRecord) : [];

  return parts
    .filter((part) => part.type === 'text')
    .map((part) => text(part.text) ?? '')
    .join('\n');
};

const codemodeCalls = (details: Entry, facts: EntryFacts): ToolCall[] => {
  const calls = Array.isArray(details.calls) ? details.calls.filter(isRecord) : [];

  return calls.flatMap((call) => {
    const tool = text(call.name);

    if (tool === undefined) {
      return [];
    }

    const error = call.status === 'error' ? (text(call.error) ?? '') : undefined;

    return [
      {
        tool,
        day: facts.day,
        side: facts.side,
        viaCodemode: true,
        arguments: parseObject(text(call.args) ?? ''),
        details: undefined,
        error,
      },
    ];
  });
};

const addAssistantCalls = (collection: HealthCollection, message: Entry, facts: EntryFacts) => {
  const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : [];

  for (const part of parts) {
    const tool = text(part.name);
    const id = text(part.id);

    if (part.type !== 'toolCall' || tool === undefined || id === undefined) {
      continue;
    }

    const call: ToolCall = {
      tool,
      day: facts.day,
      side: facts.side,
      viaCodemode: false,
      arguments: isRecord(part.arguments) ? part.arguments : undefined,
      details: undefined,
      error: undefined,
    };

    collection.calls.push(call);
    facts.pending.set(id, call);
  }
};

const addResult = (collection: HealthCollection, message: Entry, facts: EntryFacts) => {
  const call = facts.pending.get(text(message.toolCallId) ?? '');

  // A result whose call lies before the window has no call to complete.
  if (call === undefined) {
    return;
  }

  const details = isRecord(message.details) ? message.details : undefined;

  call.details = details;

  if (message.isError === true) {
    call.error = resultText(message.content);
  }

  if (call.tool === 'codemode' && details !== undefined) {
    collection.calls.push(...codemodeCalls(details, facts));
  }
};

const isNewInWindow = (collection: HealthCollection, entry: Entry, time: number) => {
  // Forks and follow-ups copy entries with their IDs and timestamps, so each copy counts once.
  const key = `${text(entry.id) ?? ''}\0${text(entry.timestamp) ?? ''}`;
  const copied = collection.seen.has(key);
  const inWindow = time >= collection.window.since && time < collection.window.until;

  collection.seen.add(key);

  if (copied && inWindow) {
    collection.copiedEntries += 1;
  }

  return inWindow && !copied;
};

// Collect files in the order their sessions started, so an original keeps the entries its copies
// share.
export const collectSessionFile = (collection: HealthCollection, file: SessionFile): void => {
  const pending = new Map<string, ToolCall>();

  if (file.side === 'manager') {
    collection.managerFiles += 1;
  } else {
    collection.workerFiles += 1;
  }

  for (const entry of parseEntries(collection, file.text)) {
    const time = Date.parse(text(entry.timestamp) ?? '');

    if (Number.isNaN(time)) {
      collection.malformedLines += 1;

      continue;
    }

    const message = entry.message;

    if (!isNewInWindow(collection, entry, time) || !isRecord(message)) {
      continue;
    }

    const facts = {
      day: new Date(time).toISOString().slice(0, isoDateLength),
      side: file.side,
      pending,
    };

    if (message.role === 'assistant') {
      addAssistantCalls(collection, message, facts);
    } else if (message.role === 'toolResult') {
      addResult(collection, message, facts);
    }
  }
};

// Numbers vary between otherwise equal errors, such as a character count.
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

  // A rule also runs on a day without calls of its tool, so a tool that stops being called shows.
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
