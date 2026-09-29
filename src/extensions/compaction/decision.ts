// Decides when and where to compact from facts the caller read. tests/structure.test.ts keeps this
// module pure.

export interface CompactionFacts {
  outcome: 'completed' | 'aborted' | 'error';
  aborted: boolean;
  compactionPending: boolean;
  // Undefined when Pi cannot count the context, such as right after a compaction.
  contextTokens: number | undefined;
  thresholdTokens: number;
  // The context size when the last summary failed, until a compaction succeeds or a session starts.
  failedAtTokens: number | undefined;
}

export interface ContextEntryFacts {
  id: string;
  // The saved entry type, such as `message` or `compaction`.
  entryType: string;
  // Roles of the model-visible messages this entry contributes.
  roles: string[];
  tokens: number;
}

const keepRecentTokens = 20_000;

// A lower threshold would compact again as soon as the kept tail and the summary fill it.
export const minimumThresholdTokens = 2 * keepRecentTokens;

// After a failed summary, retry only once the context has grown by the kept tail, so a failing
// provider is not asked again on every turn.
const isBackingOff = (contextTokens: number, failedAtTokens: number | undefined): boolean =>
  failedAtTokens !== undefined && contextTokens < failedAtTokens + keepRecentTokens;

export const shouldCompact = (facts: CompactionFacts): boolean => {
  if (facts.outcome !== 'completed') {
    return false;
  }

  if (facts.aborted || facts.compactionPending) {
    return false;
  }

  if (facts.contextTokens === undefined) {
    return false;
  }

  if (isBackingOff(facts.contextTokens, facts.failedAtTokens)) {
    return false;
  }

  return facts.contextTokens > facts.thresholdTokens;
};

const conversationRoles = new Set(['user', 'assistant']);

// A tool result must stay after its tool call, so the kept part never starts with one.
const isCutEntry = (entry: ContextEntryFacts): boolean =>
  entry.entryType !== 'compaction' &&
  entry.roles.some((role) => conversationRoles.has(role)) &&
  !entry.roles.includes('toolResult');

// The previous summary alone is not worth a new summary.
const isSummarizable = (entry: ContextEntryFacts): boolean =>
  entry.entryType !== 'compaction' && entry.roles.some((role) => role !== 'system');

const tailStart = (entries: ContextEntryFacts[], keepTokens: number): number | undefined => {
  let kept = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    kept += entries[index]?.tokens ?? 0;

    if (kept >= keepTokens) {
      return index;
    }
  }

  return undefined;
};

const nearestCutIndex = (entries: ContextEntryFacts[], start: number): number | undefined => {
  const later = entries.findIndex((entry, index) => index >= start && isCutEntry(entry));

  if (later !== -1) {
    return later;
  }

  const earlier = entries.findLastIndex((entry, index) => index < start && isCutEntry(entry));

  return earlier === -1 ? undefined : earlier;
};

// Returns the first entry to keep verbatim: the cut entry nearest after the recent tail starts.
export const chooseFirstKeptEntry = (
  entries: ContextEntryFacts[],
  keepTokens = keepRecentTokens,
): string | undefined => {
  const start = tailStart(entries, keepTokens);

  if (start === undefined) {
    return undefined;
  }

  const cut = nearestCutIndex(entries, start);

  if (cut === undefined || !entries.slice(0, cut).some(isSummarizable)) {
    return undefined;
  }

  return entries[cut]?.id;
};
