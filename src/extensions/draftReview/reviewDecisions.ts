export interface SessionComment {
  id: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  type: string;
  content: string;
}

export interface FileComment extends Omit<SessionComment, 'path'> {
  path: string;
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

export type EditDecision = 'unchanged' | 'apply' | 'conflict';

export interface WaitFacts {
  ended: boolean;
  reason: string;
}

export type WaitOutcome = 'finished' | 'message' | 'timeout' | 'unfinished';

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

export const selectReviewedComments = (
  comments: readonly SessionComment[],
  reviewedFiles: readonly { path: string; stagedPath: string }[],
): FileComment[] =>
  comments.flatMap((comment) => {
    const file = reviewedFiles.find(({ stagedPath }) => stagedPath === comment.path);

    return file === undefined ? [] : [{ ...comment, path: file.path }];
  });

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

export const decideWaitOutcome = (facts: WaitFacts): WaitOutcome => {
  if (facts.ended) {
    return 'finished';
  }

  if (facts.reason === 'message') {
    return 'message';
  }

  return facts.reason === 'timeout' ? 'timeout' : 'unfinished';
};
