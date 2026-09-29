import { isRecord, modelName, text } from './tokenUsageReport.ts';
import type { Entry } from './tokenUsageReport.ts';

export type FactKind = 'uuid' | 'sha' | 'path' | 'pr' | 'linear';

export type FactSource = 'tool result' | 'assistant' | 'user' | 'extension';

export interface Fact {
  kind: FactKind;
  value: string;
}

export interface KindCounts {
  needed: number;
  summary: number;
  kept: number;
  lost: number;
}

export interface LostFact extends Fact {
  // Where the fact first came back after the compaction.
  returnedThrough: FactSource;
}

export interface CompactionRecall {
  entryId: string;
  tokensBefore: number;
  model: string;
  counts: Map<FactKind, KindCounts>;
  lost: LostFact[];
}

interface EntryText {
  source: FactSource;
  text: string;
}

export const factKinds: FactKind[] = ['uuid', 'sha', 'path', 'pr', 'linear'];

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Lowercase hex beside a word, `#`, or `-` belongs to a color, slug, or longer token.
const shaPattern = /(?<![#\w-])[0-9a-f]{7,40}(?![\w-])/g;

const tauPathPattern = /(?<![\w./~-])(?:~\/|\/)?(?:[\w.@-]+\/)*\.tau\/[\w.@/-]*[\w@-]/g;

// A worktree is a whole home path to a directory; the prefix of a longer path does not count.
const worktreePattern =
  /(?<![\w./~-])(?:~|\/home\/[\w.-]+|\/Users\/[\w.-]+)(?:\/[\w@-][\w.@-]*)+(?![\w.@/-])/g;

const pullRequestPattern = /(?:\bPR\s*#?|\/pull\/|(?<![\w&#/])#)(\d{2,6})\b/g;

const linearPattern = /\b([A-Z]{2,5})-(\d{1,5})\b/g;

const notLinearTeams = new Set([
  'ADR',
  'CVE',
  'ECMA',
  'ES',
  'GPT',
  'HTTP',
  'ISO',
  'RFC',
  'SHA',
  'TLS',
  'UTF',
]);

const isSha = (value: string) => /\d/.test(value) && /[a-f]/.test(value);

// A path to a file names a file, not a worktree.
const isDirectory = (path: string) => !/\.\w+$/.test(path.slice(path.lastIndexOf('/') + 1));

const shaFacts = (source: string): Fact[] =>
  [...source.replaceAll(uuidPattern, ' ').matchAll(shaPattern)]
    .map((match) => match[0])
    .filter(isSha)
    .map((value) => ({ kind: 'sha', value: value.slice(0, 7) }));

const pathFacts = (source: string): Fact[] => {
  const tauPaths = [...source.matchAll(tauPathPattern)].map((match) => {
    const path = match[0];

    return path.slice(path.indexOf('.tau/'));
  });

  const worktrees = [...source.matchAll(worktreePattern)]
    .map((match) => match[0].replace(/\.+$/, ''))
    .filter(isDirectory);

  return [...tauPaths, ...worktrees].map((value) => ({ kind: 'path', value }));
};

const linearFacts = (source: string): Fact[] =>
  [...source.matchAll(linearPattern)]
    .filter((match) => !notLinearTeams.has(match[1] ?? ''))
    .map((match) => ({ kind: 'linear', value: match[0] }));

const factKey = (fact: Fact) => `${fact.kind} ${fact.value}`;

// SHAs compare by their first 7 characters and `.tau/` paths from `.tau/` on, so a short or
// relative mention matches its long form.
export const extractFacts = (source: string) => {
  const uuids: Fact[] = [...source.matchAll(uuidPattern)].map((match) => ({
    kind: 'uuid',
    value: match[0].toLowerCase(),
  }));

  const pullRequests: Fact[] = [...source.matchAll(pullRequestPattern)].map((match) => ({
    kind: 'pr',
    value: `#${match[1] ?? ''}`,
  }));

  const facts = [
    ...uuids,
    ...shaFacts(source),
    ...pathFacts(source),
    ...pullRequests,
    ...linearFacts(source),
  ];

  return new Map(facts.map((fact) => [factKey(fact), fact]));
};

const blockText = (block: unknown) => {
  if (!isRecord(block)) {
    return '';
  }

  if (block.type === 'text') {
    return text(block.text) ?? '';
  }

  // Thinking stays out: its signatures hold long encoded strings, not facts the manager used.
  return block.type === 'toolCall' ? JSON.stringify(block.arguments ?? {}) : '';
};

const contentText = (content: unknown) => {
  if (typeof content === 'string') {
    return content;
  }

  return Array.isArray(content) ? content.map(blockText).join('\n') : '';
};

const messageText = (message: Entry): EntryText | undefined => {
  if (message.role === 'user' || message.role === 'assistant') {
    return { source: message.role, text: contentText(message.content) };
  }

  if (message.role === 'toolResult') {
    return { source: 'tool result', text: contentText(message.content) };
  }

  if (message.role === 'bashExecution') {
    return {
      source: 'user',
      text: `${text(message.command) ?? ''}\n${text(message.output) ?? ''}`,
    };
  }

  return undefined;
};

// Reads the conversation text of an entry. System prompts, settings, and summaries are not
// conversation, so they return undefined.
const entryText = (entry: Entry): EntryText | undefined => {
  if (isRecord(entry.message)) {
    return messageText(entry.message);
  }

  if (entry.type === 'custom_message') {
    return { source: 'extension', text: contentText(entry.content) };
  }

  return undefined;
};

const factsOf = (entries: Entry[], extra = '') => {
  const texts = entries.map((entry) => entryText(entry)?.text ?? '');

  return extractFacts([extra, ...texts].join('\n'));
};

const pathTo = (byId: Map<string, Entry>, entry: Entry) => {
  const path: Entry[] = [];
  const visited = new Set<string>();

  for (let current: Entry | undefined = entry; current !== undefined;) {
    const id = text(current.id) ?? '';

    // A parent cycle is a broken record; stop instead of looping.
    if (visited.has(id)) {
      break;
    }

    visited.add(id);
    path.unshift(current);
    current = byId.get(text(current.parentId) ?? '');
  }

  return path;
};

const isCompaction = (entry: Entry) => entry.type === 'compaction';

const keptIndex = (path: Entry[], compaction: Entry) =>
  path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);

// The previous compaction on the path summarized everything before its kept boundary, so this
// compaction replaced its summary and the entries from that boundary on.
const replacedStart = (path: Entry[], end: number) => {
  const previous = path.slice(0, end).findLastIndex(isCompaction);

  if (previous === -1) {
    return { start: 0, previousSummary: '' };
  }

  const compaction = path[previous] ?? {};
  const kept = keptIndex(path, compaction);

  return {
    start: kept === -1 || kept > previous ? previous + 1 : kept,
    previousSummary: text(compaction.summary) ?? '',
  };
};

// Entries after the compaction on its own branch; parents come before children in a session file.
const descendants = (entries: Entry[], index: number) => {
  const ids = new Set([text(entries[index]?.id) ?? '']);

  return entries.slice(index + 1).filter((entry) => {
    const inBranch = ids.has(text(entry.parentId) ?? '');

    if (inBranch) {
      ids.add(text(entry.id) ?? '');
    }

    return inBranch;
  });
};

const firstReturns = (entries: Entry[]) => {
  const returns = new Map<string, FactSource>();

  for (const entry of entries) {
    const found = entryText(entry);

    if (found === undefined) {
      continue;
    }

    for (const key of extractFacts(found.text).keys()) {
      if (!returns.has(key)) {
        returns.set(key, found.source);
      }
    }
  }

  return returns;
};

const emptyCounts = () =>
  new Map(factKinds.map((kind) => [kind, { needed: 0, summary: 0, kept: 0, lost: 0 }]));

const lastModel = (path: Entry[]) => {
  const message = path.findLast(
    (entry) => isRecord(entry.message) && entry.message.role === 'assistant',
  )?.message;

  return isRecord(message) ? modelName(message) : 'unknown';
};

// Classifies each fact from the replaced entries that the session used again after the
// compaction. Undefined means the kept boundary is not on the compaction's path.
export const compactionRecall = (entries: Entry[], index: number): CompactionRecall | undefined => {
  const compaction = entries[index] ?? {};
  const byId = new Map(entries.map((entry) => [text(entry.id) ?? '', entry]));
  const path = pathTo(byId, compaction);
  const end = path.length - 1;
  const kept = keptIndex(path, compaction);

  if (kept === -1) {
    return undefined;
  }

  const { start, previousSummary } = replacedStart(path, Math.min(kept, end));
  const replaced = factsOf(path.slice(start, Math.min(kept, end)), previousSummary);
  const inSummary = extractFacts(text(compaction.summary) ?? '');
  const inKept = factsOf(path.slice(kept, end));
  const returns = firstReturns(descendants(entries, index));
  const counts = emptyCounts();
  const lost: LostFact[] = [];

  for (const [key, fact] of replaced) {
    const returnedThrough = returns.get(key);
    const row = counts.get(fact.kind);

    if (returnedThrough === undefined || row === undefined) {
      continue;
    }

    row.needed += 1;

    if (inSummary.has(key)) {
      row.summary += 1;
    } else if (inKept.has(key)) {
      row.kept += 1;
    } else {
      row.lost += 1;
      lost.push({ ...fact, returnedThrough });
    }
  }

  return {
    entryId: text(compaction.id) ?? '',
    tokensBefore: typeof compaction.tokensBefore === 'number' ? compaction.tokensBefore : 0,
    model: lastModel(path),
    counts,
    lost,
  };
};
