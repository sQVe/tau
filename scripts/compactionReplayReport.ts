import { compactionRecall, factKinds } from './compactionRecall.ts';
import type { CompactionRecall, KindCounts } from './compactionRecall.ts';
import {
  contextTokens,
  formatNumber,
  headerTime,
  isRecord,
  median,
  modelName,
  parseEntries,
  parseUsage,
  table,
  text,
  totalTokens,
  upsert,
} from './tokenUsageReport.ts';
import type { Entry, SessionFile, TimeWindow, Usage } from './tokenUsageReport.ts';

interface ReplaySession {
  path: string;
  entries: Entry[];
  // False for an entry that an earlier session file holds, such as a fork's copied history.
  original: boolean[];
  // An original entry inside the window.
  counted: boolean[];
}

interface ModelRow {
  model: string;
  sessions: Set<string>;
  compactingSessions: Set<string>;
  compactions: number;
  real: Usage;
  simulated: Usage;
}

export interface ThresholdReplay {
  threshold: number;
  models: Map<string, ModelRow>;
}

export interface CompactionRow extends CompactionRecall {
  path: string;
}

export interface CompactionReplayReport {
  window: TimeWindow;
  sessionFiles: number;
  unreadableFiles: number;
  malformedLines: number;
  copiedEntries: number;
  summaryTokens: number;
  summarySamples: number;
  // The median share of `tokensBefore` that real compactions sent to the summarizer.
  summarizerInputShare: number | undefined;
  replays: ThresholdReplay[];
  compactions: CompactionRow[];
  unmatchedCompactions: number;
}

interface ReplayState {
  base: number | undefined;
  previousReal: number;
  simulated: number;
}

interface ReplayedTurn {
  request: Usage;
  compaction: Usage | undefined;
}

// Pi's default `keepRecentTokens`.
const keepRecentTokens = 20_000;
const charactersPerToken = 4;
const prices: Usage = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const addUsage = (total: Usage, usage: Usage) => {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
};

const weighted = (usage: Usage) =>
  usage.input * prices.input +
  usage.output * prices.output +
  usage.cacheRead * prices.cacheRead +
  usage.cacheWrite * prices.cacheWrite;

const entryKey = (entry: Entry) => `${text(entry.id) ?? ''}\0${text(entry.timestamp) ?? ''}`;

const timeOf = (entry: Entry) => Date.parse(text(entry.timestamp) ?? '');

const markEntries = (entries: Entry[], seen: Set<string>, window: TimeWindow) => {
  const original = entries.map((entry) => {
    const copied = seen.has(entryKey(entry));

    seen.add(entryKey(entry));

    return !copied;
  });

  const inWindow = entries.map(
    (entry) => timeOf(entry) >= window.since && timeOf(entry) < window.until,
  );

  const counted = inWindow.map((inside, index) => inside && original[index] === true);
  const copied = inWindow.filter((inside, index) => inside && original[index] === false).length;

  return { original, counted, copied };
};

const prepareSessions = (files: SessionFile[], window: TimeWindow) => {
  const seen = new Set<string>();
  const sessions: ReplaySession[] = [];
  const skipped = { unreadableFiles: 0, malformedLines: 0, copiedEntries: 0 };

  // An original session starts before its forks, so the original keeps the shared entries.
  for (const file of files.toSorted((left, right) => headerTime(left) - headerTime(right))) {
    const parsed = parseEntries(file.text);
    const entries = parsed.entries.filter((entry) => !Number.isNaN(timeOf(entry)));

    skipped.malformedLines += parsed.malformedLines + parsed.entries.length - entries.length;

    if (!entries.some((entry) => entry.type === 'session')) {
      skipped.unreadableFiles += 1;

      continue;
    }

    const { original, counted, copied } = markEntries(entries, seen, window);

    skipped.copiedEntries += copied;
    sessions.push({ path: file.path, entries, original, counted });
  }

  return { sessions, skipped };
};

const windowCompactions = (sessions: ReplaySession[]) =>
  sessions.flatMap((session) =>
    session.entries.filter(
      (entry, index) => entry.type === 'compaction' && session.counted[index] === true,
    ),
  );

const summarySize = (compactions: Entry[]) => {
  const lengths = compactions.map((entry) => text(entry.summary)?.length ?? 0);

  return Math.round((median(lengths) ?? 0) / charactersPerToken);
};

const summarizerInputShare = (compactions: Entry[]) => {
  const shares = compactions.flatMap((entry) => {
    const usage = parseUsage(entry.usage);
    const tokensBefore = typeof entry.tokensBefore === 'number' ? entry.tokensBefore : 0;

    return usage === undefined || tokensBefore <= 0 ? [] : [usage.input / tokensBefore];
  });

  return median(shares);
};

// New tokens are the real turn's uncached tokens, capped at the simulated context, or the whole
// context after a compaction. They split between input and cacheWrite in the real turn's ratio.
const simulatedRequest = (usage: Usage, context: number, fresh: boolean): Usage => {
  const realNew = usage.input + usage.cacheWrite;
  const newTokens = fresh ? context : Math.min(realNew, context);
  const cacheWrite = realNew === 0 ? 0 : Math.round((newTokens * usage.cacheWrite) / realNew);

  return {
    input: newTokens - cacheWrite,
    output: usage.output,
    cacheRead: context - newTokens,
    cacheWrite,
  };
};

// Pi compacts before the next request once the context passed the threshold. A real context drop,
// such as a real compaction or a branch switch, caps the simulated context at the real one.
export const replayTurn = (
  state: ReplayState,
  usage: Usage,
  threshold: number,
  summaryTokens: number,
): ReplayedTurn => {
  const real = contextTokens(usage);
  const base = state.base ?? real;
  const before = state.simulated;
  const compacts = before > threshold;
  const start = compacts ? base + keepRecentTokens + summaryTokens : before;
  const growth = real - state.previousReal;
  const context = growth < 0 ? Math.min(start, real) : Math.min(start + growth, real);

  state.base = base;
  state.previousReal = real;
  state.simulated = context;

  const summarized = Math.max(0, before - base - keepRecentTokens);

  const compaction = compacts
    ? { input: summarized, output: summaryTokens, cacheRead: 0, cacheWrite: 0 }
    : undefined;

  return { request: simulatedRequest(usage, context, compacts), compaction };
};

const modelRow = (models: Map<string, ModelRow>, model: string) =>
  upsert(models, model, () => ({
    model,
    sessions: new Set<string>(),
    compactingSessions: new Set<string>(),
    compactions: 0,
    real: emptyUsage(),
    simulated: emptyUsage(),
  }));

const assistantUsage = (entry: Entry) => {
  const message = isRecord(entry.message) ? entry.message : undefined;

  return message?.role === 'assistant' ? parseUsage(message.usage) : undefined;
};

const replaySession = (
  session: ReplaySession,
  threshold: number,
  summaryTokens: number,
  models: Map<string, ModelRow>,
) => {
  const state: ReplayState = { base: undefined, previousReal: 0, simulated: 0 };
  let model = 'unknown';

  for (const [index, entry] of session.entries.entries()) {
    const counted = session.counted[index] === true;
    const usage = entry.type === 'compaction' ? parseUsage(entry.usage) : assistantUsage(entry);

    if (usage === undefined) {
      continue;
    }

    // A real compaction stays in the replay, so its cost counts on both sides.
    if (entry.type === 'compaction') {
      if (counted) {
        addUsage(modelRow(models, model).real, usage);
        addUsage(modelRow(models, model).simulated, usage);
      }

      continue;
    }

    model = isRecord(entry.message) ? modelName(entry.message) : model;

    const turn = replayTurn(state, usage, threshold, summaryTokens);

    if (!counted) {
      continue;
    }

    const row = modelRow(models, model);

    row.sessions.add(session.path);
    addUsage(row.real, usage);
    addUsage(row.simulated, turn.request);

    if (turn.compaction !== undefined) {
      row.compactions += 1;
      row.compactingSessions.add(session.path);
      addUsage(row.simulated, turn.compaction);
    }
  }
};

const recallRows = (sessions: ReplaySession[]) => {
  const rows: CompactionRow[] = [];
  let unmatched = 0;

  for (const session of sessions) {
    for (const [index, entry] of session.entries.entries()) {
      if (entry.type !== 'compaction' || session.counted[index] !== true) {
        continue;
      }

      const recall = compactionRecall(session.entries, index);

      if (recall === undefined) {
        unmatched += 1;
      } else {
        rows.push({ ...recall, path: session.path });
      }
    }
  }

  return { rows, unmatched };
};

export const compactionReplayReport = (
  files: SessionFile[],
  window: TimeWindow,
  thresholds: number[],
  unreadableFiles: number,
): CompactionReplayReport => {
  const { sessions, skipped } = prepareSessions(files, window);
  const compactions = windowCompactions(sessions);
  const summaryTokens = summarySize(compactions);

  const replays = thresholds.map((threshold) => {
    const models = new Map<string, ModelRow>();

    for (const session of sessions) {
      replaySession(session, threshold, summaryTokens, models);
    }

    return { threshold, models };
  });

  const recall = recallRows(sessions);

  return {
    window,
    sessionFiles: files.length,
    unreadableFiles: unreadableFiles + skipped.unreadableFiles,
    malformedLines: skipped.malformedLines,
    copiedEntries: skipped.copiedEntries,
    summaryTokens,
    summarySamples: compactions.length,
    summarizerInputShare: summarizerInputShare(compactions),
    replays,
    compactions: recall.rows,
    unmatchedCompactions: recall.unmatched,
  };
};

const formatShare = (value: number | undefined) =>
  value === undefined ? '-' : `${(value * 100).toFixed(1)}%`;

const change = (real: Usage, simulated: Usage) => {
  const before = weighted(real);

  return before === 0 ? undefined : weighted(simulated) / before - 1;
};

const usageCells = (usage: Usage) => [
  formatNumber(usage.input),
  formatNumber(usage.cacheRead),
  formatNumber(usage.cacheWrite),
  formatNumber(usage.output),
  formatNumber(totalTokens(usage)),
  formatNumber(weighted(usage)),
];

const replayRows = (row: ModelRow) => [
  [row.model, 'real', formatNumber(row.sessions.size), '-', '-', ...usageCells(row.real), '-'],
  [
    row.model,
    'simulated',
    formatNumber(row.sessions.size),
    formatNumber(row.compactingSessions.size),
    formatNumber(row.compactions),
    ...usageCells(row.simulated),
    formatShare(change(row.real, row.simulated)),
  ],
];

const allModels = (models: Map<string, ModelRow>): ModelRow => {
  const total = modelRow(new Map(), 'all models');

  for (const row of models.values()) {
    row.sessions.forEach((path) => total.sessions.add(path));
    row.compactingSessions.forEach((path) => total.compactingSessions.add(path));
    total.compactions += row.compactions;
    addUsage(total.real, row.real);
    addUsage(total.simulated, row.simulated);
  }

  return total;
};

const replayTable = (replay: ThresholdReplay) => {
  const models = [...replay.models.values()].toSorted(
    (left, right) => weighted(right.real) - weighted(left.real),
  );

  const headings = [
    'model',
    'replay',
    'sessions',
    'compacting',
    'compactions',
    'input',
    'cacheRead',
    'cacheWrite',
    'output',
    'total',
    'weighted',
    'change',
  ];

  const rows = [...models, allModels(replay.models)].flatMap(replayRows);

  return [`Threshold ${formatNumber(replay.threshold)}`, table(headings, rows)].join('\n');
};

const addCounts = (total: KindCounts, counts: KindCounts) => {
  total.needed += counts.needed;
  total.summary += counts.summary;
  total.kept += counts.kept;
  total.lost += counts.lost;
};

const emptyCounts = (): KindCounts => ({ needed: 0, summary: 0, kept: 0, lost: 0 });

const recallTable = (compactions: CompactionRow[]) => {
  const rows = factKinds.map((kind) => {
    const total = emptyCounts();
    const lost = compactions.flatMap((row) => row.lost.filter((fact) => fact.kind === kind));
    const looked = lost.filter((fact) => fact.returnedThrough === 'tool result').length;

    for (const row of compactions) {
      addCounts(total, row.counts.get(kind) ?? emptyCounts());
    }

    const recall = total.needed === 0 ? undefined : (total.summary + total.kept) / total.needed;

    return [
      kind,
      formatNumber(total.needed),
      formatNumber(total.summary),
      formatNumber(total.kept),
      formatNumber(total.lost),
      formatNumber(looked),
      formatNumber(lost.length - looked),
      formatShare(recall),
    ];
  });

  const headings = [
    'kind',
    'needed',
    'summary',
    'kept',
    'lost',
    'lost, back via tool result',
    'lost, back in a message',
    'recall',
  ];

  return table(headings, rows);
};

const neededFacts = (row: CompactionRow) =>
  [...row.counts.values()].reduce((sum, counts) => sum + counts.needed, 0);

const compactionTable = (compactions: CompactionRow[]) => {
  const rows = compactions.map((row) => [
    formatNumber(row.tokensBefore),
    row.model,
    formatNumber(neededFacts(row)),
    formatNumber(row.lost.length),
    row.entryId,
    row.path,
  ]);

  return table(['tokensBefore', 'model', 'needed', 'lost', 'entry', 'file'], rows);
};

const lostFacts = (compactions: CompactionRow[]) =>
  compactions
    .filter((row) => row.lost.length > 0)
    .map((row) => {
      const facts = row.lost.map(
        (fact) => `  ${fact.kind} ${fact.value} (back via ${fact.returnedThrough})`,
      );

      return [`${row.path} ${row.entryId}`, ...facts].join('\n');
    })
    .join('\n');

const assumptions = (report: CompactionReplayReport) => [
  'Assumptions',
  '- Walks each parent session file in order. Context per request = input + cacheRead + cacheWrite.',
  '- Pi compacts before the next request once the simulated context passes the threshold.',
  `- After a compaction the context is the session's first-request context + keepRecentTokens (${formatNumber(keepRecentTokens)}) + the summary (${formatNumber(report.summaryTokens)} tokens: median of ${formatNumber(report.summarySamples)} real summaries in the window, ${charactersPerToken} characters per token).`,
  "- Later turns add the real turn's context growth. A real context drop, such as a real compaction or a branch switch, caps the simulated context at the real one.",
  `- A compaction costs the summarized tokens (context before it - first-request context - keepRecentTokens) as uncached input, plus the summary as output. Real compactions sent a median ${formatShare(report.summarizerInputShare)} of tokensBefore to the summarizer, so this input is an upper bound.`,
  "- New tokens per request = the real turn's input + cacheWrite, capped at the simulated context. The first request after a compaction is all new. New tokens split between input and cacheWrite in the real turn's ratio; the rest is cacheRead. Output is unchanged.",
  '- Real compactions in the logs stay in the replay, and their cost counts on both sides.',
  '- Facts a compaction loses cost no extra turns here, so the replay overstates savings by the lookups they cause.',
  '- Totals leave out delegate tool usage, such as bulk_read, which compaction does not change.',
  `- Weighted tokens use price ratios input ${prices.input}, cacheWrite ${prices.cacheWrite}, cacheRead ${prices.cacheRead}, output ${prices.output}.`,
  '- Only turns and compactions timestamped inside the window count, but each session replays from its start.',
];

export const formatCompactionReplayReport = (report: CompactionReplayReport) => {
  const since = new Date(report.window.since).toISOString();
  const until = new Date(report.window.until).toISOString();

  const skipped = [
    `${formatNumber(report.sessionFiles)} session files`,
    `${formatNumber(report.unreadableFiles)} unreadable`,
    `${formatNumber(report.malformedLines)} malformed lines skipped`,
    `${formatNumber(report.copiedEntries)} copied entries counted once`,
  ].join(', ');

  return [
    `Compaction replay of parent sessions from ${since} to ${until}`,
    skipped,
    '',
    ...assumptions(report),
    '',
    ...report.replays.flatMap((replay) => [replayTable(replay), '']),
    `Summary recall over ${formatNumber(report.compactions.length)} real compactions (${formatNumber(report.unmatchedCompactions)} skipped: kept entry not on the path)`,
    'A fact from the replaced entries is needed when it appears again after the compaction. Recall = (summary + kept) / needed.',
    recallTable(report.compactions),
    '',
    'Compactions',
    compactionTable(report.compactions),
    '',
    'Lost facts',
    lostFacts(report.compactions),
    '',
  ].join('\n');
};
