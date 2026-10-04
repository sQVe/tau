import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

export type DocumentProblemKind =
  | 'broken-link'
  | 'missing-heading'
  | 'missing-path'
  | 'adr-index'
  | 'stale-allowlist';

export interface DocumentProblem {
  file: string;
  kind: DocumentProblemKind;
  detail: string;
}

export interface LinkProblem {
  kind: 'broken-link' | 'missing-heading';
  detail: string;
}

export interface Files {
  exists: (path: string) => boolean;
  readMarkdown: (path: string) => string;
}

export interface Document {
  file: string;
  markdown: string;
}

// Maps each backticked path that names no repository file on purpose to the documents that may
// name it.
export type AllowedPaths = Readonly<Record<string, readonly string[]>>;

// Fences in list items are indented, so any indentation opens a block. A closing fence may be
// longer than the opening one.
export const fencedCodeBlock =
  /^[ \t]*(([`~])\2{2,})([^\n]*)\n([\s\S]*?)(?:^[ \t]*\1\2*[ \t]*$|(?![\s\S]))/gm;

const inlineCode = /(`+)([\s\S]*?)\1/g;

const inlineLink =
  /\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

const referenceDefinition = /^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
const externalTarget = /^[a-z][a-z\d+.-]*:/i;
const atxHeading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/;
const paragraphLine = /^ {0,3}(?![#>|*+-]|\d+[.)][ \t])\S/;
const frontmatter = /^---\n[\s\S]*?\n---\n/;
const headingLink = /\[([^\]]*)\]\([^)]*\)/g;
const notSlugCharacter = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;
const notPathCharacter = /[\s<>*?$~{}[\]:@|"'=,()]/;
const adrFile = /^docs\/adr\/(\d{4})-[^/]+\.md$/;
const adrIndexEntry = /^- \[([^\n]+)\]\(\.\/(\d{4}-[^)\s]+\.md)\)[ \t]*$/gm;
const adrTitle = /^ADR (\d{4}): (.+)$/;
const adrIndexFile = 'docs/adr/README.md';

// The changelog records history, so it may name paths that no longer exist.
const historyFiles = new Set(['CHANGELOG.md']);

// Top-level directories that Tau no longer has, so a path below one is stale rather than a name.
const formerRoots = new Set(['extensions', 'skills', 'vendor']);

const withoutFences = (markdown: string) => markdown.replaceAll(fencedCodeBlock, '');

export const withoutCode = (markdown: string): string =>
  withoutFences(markdown).replaceAll(inlineCode, '');

const linkTargets = (markdown: string) =>
  [...markdown.matchAll(inlineLink), ...markdown.matchAll(referenceDefinition)].map(
    (match) => match[1] ?? match[2] ?? '',
  );

// A Setext underline needs a one-line paragraph above it, so a `---` rule after a list or a blank
// line stays a rule. A heading line ends the block before it like a blank line does.
const isSetextHeading = (lines: readonly string[], index: number) => {
  const line = lines[index] ?? '';
  const previous = lines[index - 1] ?? '';
  const next = lines[index + 1] ?? '';
  const startsBlock = previous.trim() === '' || atxHeading.test(previous);

  return startsBlock && paragraphLine.test(line) && setextUnderline.test(next);
};

const headingsOf = (markdown: string) => {
  const lines = withoutFences(markdown.replace(frontmatter, '')).split('\n');

  return lines.flatMap((line, index) => {
    const [, atx] = atxHeading.exec(line) ?? [];

    if (atx !== undefined) {
      return [atx];
    }

    return isSetextHeading(lines, index) ? [line.trim()] : [];
  });
};

// GitHub keeps the rendered text of a heading, so code and link markup do not reach the slug.
const slugOf = (heading: string) =>
  heading
    .replaceAll(headingLink, '$1')
    .replaceAll('`', '')
    .trim()
    .toLowerCase()
    .replaceAll(notSlugCharacter, '')
    .replaceAll(' ', '-');

// GitHub numbers repeated slugs from the second one on and skips numbers another heading already
// took: `Notes`, `Notes`, `Notes-1` give `notes`, `notes-1`, `notes-1-1`.
const headingSlugs = (markdown: string): Set<string> => {
  const counts = new Map<string, number>();
  const slugs = new Set<string>();

  for (const heading of headingsOf(markdown)) {
    const base = slugOf(heading);
    let slug = base;

    while (slugs.has(slug)) {
      const count = (counts.get(base) ?? 0) + 1;

      counts.set(base, count);
      slug = `${base}-${count}`;
    }

    slugs.add(slug);
  }

  return slugs;
};

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

const targetProblem = (
  file: string,
  markdown: string,
  target: string,
  files: Files,
): LinkProblem | undefined => {
  const fragmentStart = target.indexOf('#');
  const encodedPath = fragmentStart === -1 ? target : target.slice(0, fragmentStart);
  const path = decoded(encodedPath);

  if (path === undefined) {
    return { kind: 'broken-link', detail: `links to undecodable ${target}` };
  }

  const targetFile = path === '' ? file : resolve(dirname(file), path);

  if (!files.exists(targetFile)) {
    return { kind: 'broken-link', detail: `links to missing ${target}` };
  }

  if (fragmentStart === -1 || extname(targetFile) !== '.md') {
    return undefined;
  }

  const fragment = decoded(target.slice(fragmentStart + 1));
  const targetMarkdown = path === '' ? markdown : files.readMarkdown(targetFile);

  if (fragment !== undefined && headingSlugs(targetMarkdown).has(fragment)) {
    return undefined;
  }

  return { kind: 'missing-heading', detail: `links to missing heading ${target}` };
};

export const linkProblems = (file: string, markdown: string, files: Files): LinkProblem[] =>
  linkTargets(withoutCode(markdown))
    .filter((target) => !externalTarget.test(target))
    .flatMap((target) => targetProblem(file, markdown, target, files) ?? []);

export const diskFiles: Files = {
  exists: existsSync,
  readMarkdown: (path) => readFileSync(path, 'utf8'),
};

// Every file and every directory that holds one, relative to the repository root.
const repositoryPathsOf = (repositoryFiles: readonly string[]) => {
  const paths = new Set<string>();

  for (const file of repositoryFiles) {
    const segments = file.split('/');

    for (let length = 1; length <= segments.length; length += 1) {
      paths.add(segments.slice(0, length).join('/'));
    }
  }

  return paths;
};

// A path names a current or former top-level entry of the repository and a file or directory
// below it. Other code spans are commands, globs, placeholders, or names.
const isRepositoryPath = (span: string, repositoryPaths: ReadonlySet<string>) => {
  const [topLevel = ''] = span.split('/');

  if (!span.includes('/') || notPathCharacter.test(span)) {
    return false;
  }

  return repositoryPaths.has(topLevel) || formerRoots.has(topLevel);
};

const backtickedPaths = (markdown: string, repositoryPaths: ReadonlySet<string>): string[] =>
  [...withoutFences(markdown).matchAll(inlineCode)]
    .map((match) => (match[2] ?? '').trim().replace(/^\.\//, ''))
    .filter((span) => isRepositoryPath(span, repositoryPaths));

const pathExists = (path: string, repositoryPaths: ReadonlySet<string>) =>
  repositoryPaths.has(path.replace(/\/+$/, ''));

const adrLabel = (file: string, markdown: string) => {
  const [, fileNumber] = adrFile.exec(file) ?? [];
  const [heading = ''] = headingsOf(markdown);
  const [, headingNumber, title] = adrTitle.exec(heading) ?? [];

  if (title === undefined) {
    return { problem: `${file} must start with a heading "ADR NNNN: Title"` };
  }

  if (headingNumber !== fileNumber) {
    return { problem: `${file} has heading number ${headingNumber}` };
  }

  return { label: `${fileNumber}: ${title}` };
};

const adrProblems = (adr: Document, entries: readonly { label: string; name: string }[]) => {
  const name = adr.file.slice('docs/adr/'.length);
  const listed = entries.filter((entry) => entry.name === name);
  const [entry] = listed;

  if (entry === undefined || listed.length > 1) {
    return [`lists ${name} ${listed.length} times`];
  }

  const { label, problem } = adrLabel(adr.file, adr.markdown);

  if (problem !== undefined) {
    return [problem];
  }

  return entry.label === label ? [] : [`lists ${name} as "${entry.label}", not "${label}"`];
};

// The index must list each ADR once, titled as its first heading.
const adrIndexProblems = (index: string, adrs: readonly Document[]): string[] => {
  const entries = [...index.matchAll(adrIndexEntry)].map((match) => ({
    label: match[1] ?? '',
    name: match[2] ?? '',
  }));

  const names = new Set(adrs.map((adr) => adr.file.slice('docs/adr/'.length)));

  const unknownEntries = entries
    .filter((entry) => !names.has(entry.name))
    .map((entry) => `lists ${entry.name}, which is not an ADR`);

  return [...unknownEntries, ...adrs.flatMap((adr) => adrProblems(adr, entries))];
};

const repositoryFilesOf = (
  root: string,
  documents: readonly Document[],
  repositoryPaths: ReadonlySet<string>,
): Files => {
  const markdownByFile = new Map(
    documents.map(({ file, markdown }) => [join(root, file), markdown]),
  );

  return {
    exists: (path: string) => {
      const relativePath = relative(root, path);

      return relativePath === '' || repositoryPaths.has(relativePath);
    },
    readMarkdown: (path: string) => markdownByFile.get(path) ?? '',
  };
};

/**
 * Checks Markdown files given as paths relative to `root`. `allFiles` lists every file in the
 * repository.
 */
export const documentProblems = (
  root: string,
  documents: readonly Document[],
  allFiles: readonly string[],
  allowedPaths: AllowedPaths,
): DocumentProblem[] => {
  const repositoryPaths = repositoryPathsOf(allFiles);
  const files = repositoryFilesOf(root, documents, repositoryPaths);
  const named = new Set<string>();
  const problems: DocumentProblem[] = [];

  for (const { file, markdown } of documents) {
    for (const { kind, detail } of linkProblems(join(root, file), markdown, files)) {
      problems.push({ file, kind, detail });
    }

    const paths = historyFiles.has(file) ? [] : backtickedPaths(markdown, repositoryPaths);

    for (const path of paths) {
      const allowed = allowedPaths[path]?.includes(file) ?? false;

      named.add(`${file}\0${path}`);

      if (!pathExists(path, repositoryPaths) && !allowed) {
        problems.push({ file, kind: 'missing-path', detail: `names missing path ${path}` });
      }
    }
  }

  const index = documents.find((document) => document.file === adrIndexFile);
  const adrs = documents.filter((document) => adrFile.test(document.file));

  const indexProblems = adrIndexProblems(index?.markdown ?? '', adrs).map((detail) => ({
    file: adrIndexFile,
    kind: 'adr-index' as const,
    detail,
  }));

  const staleEntries = Object.entries(allowedPaths).flatMap(([path, allowedFiles]) =>
    allowedFiles
      .filter((file) => !named.has(`${file}\0${path}`) || pathExists(path, repositoryPaths))
      .map((file) => ({
        file: 'tests/markdownFiles.test.ts',
        kind: 'stale-allowlist' as const,
        detail: `allows ${path} in ${file}, which does not name it as a missing path`,
      })),
  );

  return [...problems, ...indexProblems, ...staleEntries];
};

// Untracked files count unless Git ignores them, so a new file may be documented before `git add`.
const listRepositoryFiles = (root: string) =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(root, file)));

export const findDocumentProblems = (
  root: string,
  allowedPaths: AllowedPaths,
): DocumentProblem[] => {
  const allFiles = [...new Set(listRepositoryFiles(root))];

  const documents = allFiles
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, markdown: readFileSync(join(root, file), 'utf8') }));

  return documentProblems(root, documents, allFiles, allowedPaths);
};
