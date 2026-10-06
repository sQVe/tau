export interface DiffComparison {
  // Paths in both diffs whose sections differ.
  differing: string[];
  // Paths only in the reviewed diff.
  missing: string[];
  // Paths only in the current diff.
  extra: string[];
}

export interface ReuseFacts {
  recordedHash: string;
  // The git hash-object of the saved recheck.diff.
  recheckHash: string;
  // null for a root commit capture.
  recordedBase: string | null;
  mergeBase: string;
  // Whether the recorded base is an ancestor of the merge base, or the same commit.
  baseIsAncestor: boolean;
  comparison: DiffComparison;
}

interface Section {
  path: string;
  body: string;
}

export interface Reuse {
  status: 'match' | 'mismatch';
  reasons: string[];
}

const headerPrefix = 'diff --git ';

// A patch line starts with a space, +, or -, so only a section header can start with the prefix.
const sectionStarts = (text: string) => {
  const starts = text.startsWith(headerPrefix) ? [0] : [];
  let index = text.indexOf(`\n${headerPrefix}`);

  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf(`\n${headerPrefix}`, index + 1);
  }

  if (starts[0] !== 0 && text !== '') {
    starts.unshift(0);
  }

  return starts;
};

const headerPaths = (section: string) => {
  const end = section.indexOf('\n');
  const header = end === -1 ? section : section.slice(0, end);

  return header.startsWith(headerPrefix) ? header.slice(headerPrefix.length) : '';
};

// Names the path of a header such as "diff --git a/one.ts b/one.ts", and keeps the header's two
// paths when they differ, as for a rename.
const displayPath = (paths: string) => {
  const half = (paths.length - 1) / 2;
  const source = paths.slice(0, half);
  const destination = paths.slice(half + 1);
  const named = source.startsWith('a/') && destination.startsWith('b/');
  const same = named && source.slice(2) === destination.slice(2);
  const path = same ? source.slice(2) : paths;

  return Buffer.from(path, 'latin1').toString('utf8');
};

// Keys each section by its whole header, since a rename's display path can equal a file's path.
// Latin-1 keeps one character per byte, so equal strings mean equal bytes.
const splitSections = (diff: Buffer) => {
  const text = diff.toString('latin1');
  const starts = sectionStarts(text);
  const sections = new Map<string, Section>();

  for (const [index, start] of starts.entries()) {
    const body = text.slice(start, starts[index + 1]);
    const key = headerPaths(body);
    const earlier = sections.get(key)?.body ?? '';

    sections.set(key, { path: displayPath(key), body: earlier + body });
  }

  return sections;
};

const pathsOf = (sections: Map<string, Section>, keys: string[]) =>
  keys.map((key) => sections.get(key)?.path ?? key).toSorted();

export const compareDiffs = (reviewed: Buffer, current: Buffer): DiffComparison => {
  const reviewedSections = splitSections(reviewed);
  const currentSections = splitSections(current);
  const reviewedKeys = [...reviewedSections.keys()];
  const currentKeys = [...currentSections.keys()];

  const differing = reviewedKeys.filter((key) => {
    const section = currentSections.get(key);

    return section !== undefined && section.body !== reviewedSections.get(key)?.body;
  });

  const missing = reviewedKeys.filter((key) => !currentSections.has(key));
  const extra = currentKeys.filter((key) => !reviewedSections.has(key));

  return {
    differing: pathsOf(reviewedSections, differing),
    missing: pathsOf(reviewedSections, missing),
    extra: pathsOf(currentSections, extra),
  };
};

const baseReason = (facts: ReuseFacts) => {
  if (facts.recordedBase === null) {
    return 'The review captured a root commit, not a branch range.';
  }

  if (facts.recordedBase === facts.mergeBase || facts.baseIsAncestor) {
    return undefined;
  }

  return `The review base ${facts.recordedBase} is not an ancestor of the merge base ${facts.mergeBase}.`;
};

const comparisonReasons = ({ differing, missing, extra }: DiffComparison) => {
  const reasons: string[] = [];

  if (differing.length > 0) {
    reasons.push(`These paths changed since the review: ${differing.join(', ')}.`);
  }

  if (missing.length > 0) {
    reasons.push(
      `The review covers paths that the branch no longer changes: ${missing.join(', ')}.`,
    );
  }

  if (extra.length > 0) {
    reasons.push(`The branch changes paths that the review does not cover: ${extra.join(', ')}.`);
  }

  return reasons;
};

export const decideReuse = (facts: ReuseFacts): Reuse => {
  const reasons: string[] = [];

  if (facts.recheckHash !== facts.recordedHash) {
    reasons.push(
      `recheck.diff has hash ${facts.recheckHash}, not the recorded capture hash ${facts.recordedHash}.`,
    );
  }

  const base = baseReason(facts);

  if (base !== undefined) {
    reasons.push(base);
  }

  reasons.push(...comparisonReasons(facts.comparison));

  const status = reasons.length === 0 ? 'match' : 'mismatch';

  return { status, reasons };
};
