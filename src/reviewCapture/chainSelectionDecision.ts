import type { PinnedTarget } from './target.js';

interface EntryName {
  directory: string;
}

interface ReadEntry extends EntryName {
  status: 'read';
  base: string | null;
  identity: string;
  hasWorkerReports: boolean;
}

export type ChainEntryFacts =
  | (EntryName & { status: 'malformed'; reason: string })
  | (ReadEntry & { kind: Exclude<PinnedTarget['kind'], 'fix'> })
  | (ReadEntry & {
      kind: 'fix';
      review: string;
      predecessor: { identity: string } | undefined;
    });

export interface ChainSelectionFacts {
  mergeBase: string;
  review: string | undefined;
  entries: ChainEntryFacts[];
}

export interface ChainLink {
  directory: string;
  identity: string;
}

export type ChainGap =
  | { kind: 'noChain' }
  | { kind: 'malformedCapture'; directory: string; reason: string }
  | { kind: 'missingLink'; directory: string; predecessor: string }
  | { kind: 'unavailableIdentity'; directory: string }
  | { kind: 'ambiguousChain'; candidates: string[][] }
  | { kind: 'unknownReview'; review: string };

export interface ChainSelection {
  chain: ChainLink[] | null;
  gaps: ChainGap[];
}

type ReadEntryFacts = Extract<ChainEntryFacts, { status: 'read' }>;

type FixEntryFacts = Extract<ReadEntryFacts, { kind: 'fix' }>;

interface Chain {
  root: ReadEntryFacts;
  fixes: FixEntryFacts[];
}

const rootKinds = new Set<PinnedTarget['kind']>(['range', 'workingTree']);

const baseName = (directory: string) =>
  directory.split('/').findLast((segment) => segment !== '') ?? '';

const isRead = (entry: ChainEntryFacts): entry is ReadEntryFacts => entry.status === 'read';

const isFix = (entry: ReadEntryFacts): entry is FixEntryFacts => entry.kind === 'fix';

const isRoot = (entry: ReadEntryFacts, mergeBase: string) =>
  rootKinds.has(entry.kind) && entry.base === mergeBase && entry.hasWorkerReports;

// Lists the fixes that follow a link, one list per tip. It ends because each fix names one
// predecessor and each directory has one entry, so no walk from a root meets a link twice.
const tailsFrom = (link: ReadEntryFacts, fixes: FixEntryFacts[]): FixEntryFacts[][] => {
  const name = baseName(link.directory);
  const successors = fixes.filter((fix) => baseName(fix.review) === name);

  if (successors.length === 0) {
    return [[]];
  }

  return successors.flatMap((successor) =>
    tailsFrom(successor, fixes).map((tail) => [successor].concat(tail)),
  );
};

const chainsFrom = (root: ReadEntryFacts, fixes: FixEntryFacts[]): Chain[] =>
  tailsFrom(root, fixes).map((tail) => ({ root, fixes: tail }));

const directoriesOf = ({ root, fixes }: Chain) => [root, ...fixes].map((link) => link.directory);

const containsReview = (chain: Chain, review: string) =>
  directoriesOf(chain).some((directory) => baseName(directory) === baseName(review));

// An earlier link takes the identity its successor recorded. Only the last link takes the hash of
// its own file.
const identifiedLinks = ({ root, fixes }: Chain) =>
  [root, ...fixes].map((link, index) => {
    const successor = fixes[index];
    const identity = successor === undefined ? link.identity : successor.predecessor?.identity;

    return { directory: link.directory, identity };
  });

const selectOnly = (chain: Chain): ChainSelection => {
  const links = identifiedLinks(chain);

  const identified = links.flatMap(({ directory, identity }) =>
    identity === undefined ? [] : [{ directory, identity }],
  );

  const gaps = links
    .filter((link) => link.identity === undefined)
    .map(({ directory }): ChainGap => ({ kind: 'unavailableIdentity', directory }));

  return { chain: identified.length === links.length ? identified : null, gaps };
};

const selectAmong = (chains: Chain[], review: string | undefined): ChainSelection => {
  const [only, ...others] = chains;

  if (only === undefined) {
    const gap: ChainGap =
      review === undefined ? { kind: 'noChain' } : { kind: 'unknownReview', review };

    return { chain: null, gaps: [gap] };
  }

  if (others.length > 0) {
    return {
      chain: null,
      gaps: [{ kind: 'ambiguousChain', candidates: chains.map(directoriesOf) }],
    };
  }

  return selectOnly(only);
};

const recordGaps = (entries: ChainEntryFacts[], mergeBase: string): ChainGap[] => {
  const read = entries.filter(isRead);
  const names = new Set(read.map((entry) => baseName(entry.directory)));

  const malformed = entries.flatMap((entry): ChainGap[] =>
    entry.status === 'malformed'
      ? [{ kind: 'malformedCapture', directory: entry.directory, reason: entry.reason }]
      : [],
  );

  const missing = read
    .filter(isFix)
    .filter((fix) => fix.base === mergeBase && !names.has(baseName(fix.review)))
    .map((fix): ChainGap => ({
      kind: 'missingLink',
      directory: fix.directory,
      predecessor: fix.review,
    }));

  return [...malformed, ...missing];
};

export const decideChainSelection = ({
  mergeBase,
  review,
  entries,
}: ChainSelectionFacts): ChainSelection => {
  const read = entries.filter(isRead);
  const fixes = read.filter(isFix);

  const chains = read
    .filter((entry) => isRoot(entry, mergeBase))
    .flatMap((root) => chainsFrom(root, fixes));

  const candidates =
    review === undefined ? chains : chains.filter((chain) => containsReview(chain, review));

  const selection = selectAmong(candidates, review);

  return { chain: selection.chain, gaps: [...recordGaps(entries, mergeBase), ...selection.gaps] };
};
