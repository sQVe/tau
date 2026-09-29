export type Side = 'parent' | 'worker';

export interface WorkerTask {
  taskId: string;
  harness: string;
  name: string;
  profile: string;
  createdAt: number;
  sessionFile: string | undefined;
}

export interface SessionFile {
  path: string;
  side: Side;
  text: string;
  // A follow-up task continues its predecessor's session file, so one file can hold several tasks.
  tasks: WorkerTask[];
}

export interface TimeWindow {
  since: number;
  until: number;
}

export interface SkippedRecords {
  unreadableFiles: number;
  // Claude and Codex workers write no Pi session, so the report cannot measure them.
  otherHarnessTasks: WorkerTask[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface KindRow extends Usage {
  side: Side;
  source: string;
}

interface Group {
  side: Side;
  profile: string;
  model: string;
  sessions: Set<string>;
  turns: number;
  tokens: number;
  firstRequests: number[];
  // The last context per session and task, so each follow-up task ends with its own final context.
  finalContexts: Map<string, number>;
}

interface SessionRow {
  path: string;
  side: Side;
  owner: string;
  turns: number;
  tokens: number;
}

interface ToolRow {
  side: Side;
  tool: string;
  results: number;
  characters: number;
}

export interface TokenUsageReport {
  window: TimeWindow;
  sessionFiles: number;
  unreadableFiles: number;
  malformedLines: number;
  copiedEntries: number;
  turnsWithoutUsage: number;
  otherHarnessTasks: number;
  kinds: Map<string, KindRow>;
  groups: Map<string, Group>;
  sessions: SessionRow[];
  tools: Map<string, ToolRow>;
}

export type Entry = Record<string, unknown>;

interface CountedFile {
  file: SessionFile;
  row: SessionRow;
  firstTurnSeen: boolean;
}

export const isRecord = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

const isOptionalText = (value: unknown) => value === undefined || typeof value === 'string';

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

export const parseWorkerTask = (source: string): WorkerTask | undefined => {
  let record: unknown;

  try {
    record = JSON.parse(source);
  } catch {
    return undefined;
  }

  if (!isRecord(record)) {
    return undefined;
  }

  const taskId = text(record.taskId);

  if (taskId === undefined || typeof record.createdAt !== 'number') {
    return undefined;
  }

  const loadout = record.loadout ?? {};

  if (!isRecord(loadout)) {
    return undefined;
  }

  // Older records omit these fields; a present field of another type is a broken record.
  const optionalFields = [record.name, record.nativeSessionFile, loadout.profile, loadout.harness];

  if (!optionalFields.every(isOptionalText)) {
    return undefined;
  }

  return {
    taskId,
    harness: text(loadout.harness) ?? 'pi',
    name: text(record.name) ?? taskId,
    profile: text(loadout.profile) ?? 'unknown',
    createdAt: record.createdAt,
    sessionFile: text(record.nativeSessionFile),
  };
};

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// A follow-up names its predecessor's session file, and older records keep it beside the task
// record. Records copied from another agent directory keep stale absolute paths, so compare the
// file name, which is the unique native session ID.
export const ownsSession = (task: WorkerTask, taskDirectory: string, sessionPath: string) => {
  const named =
    task.sessionFile !== undefined && fileName(task.sessionFile) === fileName(sessionPath);

  return named || `${taskDirectory}/${fileName(sessionPath)}` === sessionPath;
};

export const contextTokens = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

export const totalTokens = (usage: Usage) => contextTokens(usage) + usage.output;

export const parseUsage = (value: unknown): Usage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage = {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
  };

  return totalTokens(usage) === 0 ? undefined : usage;
};

export const median = (values: number[]) => {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = values.toSorted((left, right) => left - right);
  const upper = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const lower = sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;

  return (lower + upper) / 2;
};

export const parseEntries = (source: string) => {
  const entries: Entry[] = [];
  let malformedLines = 0;

  for (const line of source.split('\n').filter((candidate) => candidate.trim() !== '')) {
    try {
      const entry: unknown = JSON.parse(line);

      if (isRecord(entry)) {
        entries.push(entry);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { entries, malformedLines };
};

export const upsert = <Value>(map: Map<string, Value>, key: string, create: () => Value) => {
  const value = map.get(key) ?? create();

  map.set(key, value);

  return value;
};

const addUsage = (report: TokenUsageReport, counted: CountedFile, source: string, usage: Usage) => {
  const { side } = counted.file;

  const row = upsert(report.kinds, `${side}\0${source}`, () => ({
    side,
    source,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }));

  row.input += usage.input;
  row.output += usage.output;
  row.cacheRead += usage.cacheRead;
  row.cacheWrite += usage.cacheWrite;
  counted.row.tokens += totalTokens(usage);
};

const taskAt = (tasks: WorkerTask[], time: number) =>
  tasks.findLast((task) => task.createdAt <= time) ?? tasks[0];

export const modelName = (message: Entry) => {
  const model = text(message.model) ?? 'unknown';
  const provider = text(message.provider);

  return provider === undefined ? model : `${provider}/${model}`;
};

const countTurn = (
  report: TokenUsageReport,
  counted: CountedFile,
  message: Entry,
  time: number,
) => {
  const usage = parseUsage(message.usage);

  if (usage === undefined) {
    report.turnsWithoutUsage += 1;

    return;
  }

  const { side, path, tasks } = counted.file;
  const task = taskAt(tasks, time);
  const profile = side === 'parent' ? 'parent' : (task?.profile ?? 'unknown');
  const model = modelName(message);

  const group = upsert(report.groups, `${side}\0${profile}\0${model}`, () => ({
    side,
    profile,
    model,
    sessions: new Set<string>(),
    turns: 0,
    tokens: 0,
    firstRequests: [],
    finalContexts: new Map<string, number>(),
  }));

  if (!counted.firstTurnSeen) {
    group.firstRequests.push(contextTokens(usage));
  }

  group.sessions.add(path);
  group.turns += 1;
  group.tokens += totalTokens(usage);
  group.finalContexts.set(`${path}\0${task?.taskId ?? ''}`, contextTokens(usage));
  counted.row.turns += 1;
  addUsage(report, counted, 'assistant', usage);
};

const countToolOutput = (report: TokenUsageReport, side: Side, message: Entry) => {
  const tool = text(message.toolName) ?? 'unknown';

  const row = upsert(report.tools, `${side}\0${tool}`, () => ({
    side,
    tool,
    results: 0,
    characters: 0,
  }));

  const content = Array.isArray(message.content) ? message.content : [];

  for (const block of content) {
    if (isRecord(block) && block.type === 'text') {
      row.characters += text(block.text)?.length ?? 0;
    }
  }

  row.results += 1;

  return tool;
};

const countOtherUsage = (
  report: TokenUsageReport,
  counted: CountedFile,
  source: string,
  value: unknown,
) => {
  const usage = parseUsage(value);

  if (usage !== undefined) {
    addUsage(report, counted, source, usage);
  }
};

// Worker activity snapshots in custom messages repeat a running total, so they never count.
const countEntry = (report: TokenUsageReport, counted: CountedFile, entry: Entry, time: number) => {
  const message = isRecord(entry.message) ? entry.message : undefined;

  if (message?.role === 'assistant') {
    countTurn(report, counted, message, time);
  } else if (message?.role === 'toolResult') {
    const tool = countToolOutput(report, counted.file.side, message);

    countOtherUsage(report, counted, `tool ${tool}`, message.usage);
  } else if (entry.type === 'usage') {
    countOtherUsage(report, counted, `usage ${text(entry.kind) ?? 'unknown'}`, entry.usage);
  } else if (entry.type !== 'custom_message') {
    countOtherUsage(report, counted, text(entry.type) ?? 'unknown', entry.usage);
  }
};

const isMeasuredTurn = (entry: Entry) =>
  isRecord(entry.message) &&
  entry.message.role === 'assistant' &&
  parseUsage(entry.message.usage) !== undefined;

const countInWindow = (
  report: TokenUsageReport,
  counted: CountedFile,
  entry: Entry,
  seen: Set<string>,
) => {
  const time = Date.parse(text(entry.timestamp) ?? '');

  if (Number.isNaN(time)) {
    report.malformedLines += 1;

    return;
  }

  // Forks and clones copy entries with their IDs and timestamps, so each copy counts once.
  const key = `${text(entry.id) ?? ''}\0${text(entry.timestamp) ?? ''}`;
  const inWindow = time >= report.window.since && time < report.window.until;

  if (!inWindow) {
    seen.add(key);

    return;
  }

  if (seen.has(key)) {
    report.copiedEntries += 1;
  } else {
    countEntry(report, counted, entry, time);
  }

  seen.add(key);
};

const countFile = (report: TokenUsageReport, file: SessionFile, seen: Set<string>) => {
  const { entries, malformedLines } = parseEntries(file.text);

  report.malformedLines += malformedLines;

  const header = entries.find((entry) => entry.type === 'session');

  if (header === undefined) {
    report.unreadableFiles += 1;

    return;
  }

  const taskNames = file.tasks.map((task) => `${task.profile} ${task.name}`);
  const owner = taskNames.length > 0 ? taskNames.join(', ') : (text(header.cwd) ?? '');
  const row = { path: file.path, side: file.side, owner, turns: 0, tokens: 0 };
  const counted: CountedFile = { file, row, firstTurnSeen: false };

  for (const entry of entries) {
    countInWindow(report, counted, entry, seen);

    // A fork's copied history is not its own first request.
    if (isMeasuredTurn(entry)) {
      counted.firstTurnSeen = true;
    }
  }

  if (row.tokens > 0) {
    report.sessions.push(row);
  }
};

export const headerTime = (file: SessionFile) => {
  const [firstLine = ''] = file.text.split('\n', 1);

  try {
    const header: unknown = JSON.parse(firstLine);

    return isRecord(header) ? Date.parse(text(header.timestamp) ?? '') || 0 : 0;
  } catch {
    return 0;
  }
};

export const tokenUsageReport = (
  files: SessionFile[],
  window: TimeWindow,
  skipped: SkippedRecords,
): TokenUsageReport => {
  const inWindow = (task: WorkerTask) =>
    task.createdAt >= window.since && task.createdAt < window.until;

  const report: TokenUsageReport = {
    window,
    sessionFiles: files.length,
    unreadableFiles: skipped.unreadableFiles,
    malformedLines: 0,
    copiedEntries: 0,
    turnsWithoutUsage: 0,
    otherHarnessTasks: skipped.otherHarnessTasks.filter(inWindow).length,
    kinds: new Map(),
    groups: new Map(),
    sessions: [],
    tools: new Map(),
  };

  const seen = new Set<string>();

  // An original session starts before its forks, so the original keeps the shared entries.
  for (const file of files.toSorted((left, right) => headerTime(left) - headerTime(right))) {
    const tasks = file.tasks.toSorted((left, right) => left.createdAt - right.createdAt);

    countFile(report, { ...file, tasks }, seen);
  }

  return report;
};

export const formatNumber = (value: number | undefined) =>
  value === undefined ? '-' : Math.round(value).toLocaleString('en-US');

export const table = (headings: string[], rows: string[][]) => {
  const all = [headings, ...rows];

  const widths = headings.map((_, column) =>
    Math.max(...all.map((row) => row[column]?.length ?? 0)),
  );

  const pad = (row: string[]) =>
    row
      .map((cell, column) => {
        const width = widths[column] ?? 0;

        return /^[\d,-]+$/.test(cell) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return all.map(pad).join('\n');
};

const bySideThen =
  <Row extends { side: Side }>(difference: (left: Row, right: Row) => number) =>
  (left: Row, right: Row) =>
    left.side.localeCompare(right.side) || difference(left, right);

const kindTable = (report: TokenUsageReport) => {
  const rows = [...report.kinds.values()]
    .toSorted(bySideThen((left: KindRow, right: KindRow) => totalTokens(right) - totalTokens(left)))
    .map((row) => [
      row.side,
      row.source,
      formatNumber(row.input),
      formatNumber(row.output),
      formatNumber(row.cacheRead),
      formatNumber(row.cacheWrite),
      formatNumber(totalTokens(row)),
    ]);

  return table(['side', 'source', 'input', 'output', 'cacheRead', 'cacheWrite', 'total'], rows);
};

const profileTable = (report: TokenUsageReport) => {
  const rows = [...report.groups.values()]
    .toSorted(bySideThen((left: Group, right: Group) => right.tokens - left.tokens))
    .map((group) => [
      group.profile,
      group.model,
      formatNumber(group.sessions.size),
      formatNumber(group.turns),
      formatNumber(group.tokens),
      formatNumber(median(group.firstRequests)),
      formatNumber(median([...group.finalContexts.values()])),
    ]);

  return table(
    ['profile', 'model', 'sessions', 'turns', 'tokens', 'median first', 'median final'],
    rows,
  );
};

const sessionTable = (report: TokenUsageReport, top: number) => {
  const rows = report.sessions
    .toSorted((left, right) => right.tokens - left.tokens)
    .slice(0, top)
    .map((row) => [
      formatNumber(row.tokens),
      formatNumber(row.turns),
      row.side,
      row.owner,
      row.path,
    ]);

  return table(['tokens', 'turns', 'side', 'tasks or cwd', 'file'], rows);
};

const toolTable = (report: TokenUsageReport) => {
  const rows = [...report.tools.values()]
    .toSorted(bySideThen((left: ToolRow, right: ToolRow) => right.characters - left.characters))
    .map((row) => [row.side, row.tool, formatNumber(row.results), formatNumber(row.characters)]);

  return table(['side', 'tool', 'results', 'characters'], rows);
};

export const formatTokenUsageReport = (report: TokenUsageReport, top: number) => {
  const since = new Date(report.window.since).toISOString();
  const until = new Date(report.window.until).toISOString();

  const skipped = [
    `${formatNumber(report.sessionFiles)} session files`,
    `${formatNumber(report.unreadableFiles)} unreadable`,
    `${formatNumber(report.malformedLines)} malformed lines skipped`,
    `${formatNumber(report.copiedEntries)} copied entries counted once`,
    `${formatNumber(report.turnsWithoutUsage)} assistant messages without usage`,
    `${formatNumber(report.otherHarnessTasks)} Claude or Codex worker tasks not measured`,
  ].join(', ');

  return [
    `Token use from ${since} to ${until}`,
    skipped,
    '',
    'Tokens by kind (tool rows are delegate usage, such as bulk_read)',
    kindTable(report),
    '',
    'Assistant turns by profile and model (context = input + cacheRead + cacheWrite)',
    profileTable(report),
    '',
    `Top ${top} sessions by tokens`,
    sessionTable(report, top),
    '',
    'Tool output characters',
    toolTable(report),
    '',
  ].join('\n');
};
