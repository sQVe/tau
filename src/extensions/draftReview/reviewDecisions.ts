export interface SessionComment {
  id: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  type: string;
  content: string;
}

export interface FileFacts {
  path: string;
  // The file as it was when the review began.
  original: string;
  // The staged file after the review, or undefined when the user removed it.
  staged: string | undefined;
  // The real file now, or undefined when it is gone.
  current: string | undefined;
}

export interface DestinationFacts {
  kind: 'file' | 'symlink' | 'other';
  linkCount: number;
  insideTauDirectory: boolean;
}

export type DestinationDecision = 'writable' | 'symlink' | 'not-file' | 'hard-linked' | 'outside';

export type ReviewPlacement = 'right' | 'tab';

export type EditDecision = 'unchanged' | 'apply' | 'conflict';

const nameByteLimit = 255;

const truncateToBytes = (text: string, limit: number) => {
  let result = '';

  for (const character of text) {
    if (Buffer.byteLength(result + character) > limit) {
      break;
    }

    result += character;
  }

  return result;
};

// File systems cap one name at 255 bytes. The number alone keeps a cut name unique among its
// siblings.
const numbered = (index: number, count: number, minimumWidth: number, name: string) => {
  const width = Math.max(minimumWidth, String(count).length);
  const prefix = `${String(index + 1).padStart(width, '0')}-`;

  return `${prefix}${truncateToBytes(name, nameByteLimit - prefix.length)}`;
};

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

// A file directly in `.tau` is its own top entry.
const topEntryOf = (path: string) => folderOf(path) || path;

// tuicr sorts files by name, so numbered names keep the order the caller gave. A top entry is the
// folder of a file, flattened into one name and numbered by its first path, or a file directly in
// `.tau`. The numbers keep two flattened folders with the same name apart.
export const stagedNames = (paths: readonly string[]): string[] => {
  const topEntries = [...new Set(paths.map(topEntryOf))];

  return paths.map((path) => {
    const topEntry = topEntryOf(path);
    const flattened = topEntry.replaceAll('/', '-');
    const topName = numbered(topEntries.indexOf(topEntry), topEntries.length, 2, flattened);

    if (topEntry === path) {
      return topName;
    }

    const siblings = paths.filter((sibling) => topEntryOf(sibling) === topEntry);
    const fileName = path.slice(topEntry.length + 1);

    return `${topName}/${numbered(siblings.indexOf(path), siblings.length, 1, fileName)}`;
  });
};

// Session-level comments have no path and belong to no reviewed file.
export const selectReviewedComments = (
  comments: readonly SessionComment[],
  reviewedPaths: readonly string[],
): SessionComment[] =>
  comments.filter((comment) => comment.path !== null && reviewedPaths.includes(comment.path));

// A changed file is written back only while the real file still matches what the review began with.
// A real file that already holds the staged text is a retry of an earlier write, so it applies.
export const decideEdit = (facts: FileFacts): EditDecision => {
  if (facts.staged === undefined || facts.staged === facts.original) {
    return 'unchanged';
  }

  const writable = facts.current === facts.original || facts.current === facts.staged;

  return writable ? 'apply' : 'conflict';
};

// A write must reach only the one regular file the review staged: a symlink, a file with another
// hard link, or a path that resolves outside `.tau` could write to a file the user never reviewed.
export const decideDestination = (facts: DestinationFacts): DestinationDecision => {
  if (facts.kind === 'symlink') {
    return 'symlink';
  }

  if (facts.kind === 'other') {
    return 'not-file';
  }

  if (facts.linkCount > 1) {
    return 'hard-linked';
  }

  return facts.insideTauDirectory ? 'writable' : 'outside';
};

// A right split halves the agent pane, so it needs room for two usable panes.
export const reviewPlacement = (facts: {
  width: number;
  zoomed: boolean;
  minimumWidth: number;
}): ReviewPlacement => {
  const roomForSplit = Math.floor(facts.width / 2) >= facts.minimumWidth;

  return !facts.zoomed && roomForSplit ? 'right' : 'tab';
};
