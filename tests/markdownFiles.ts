import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import {
  decodedComponent,
  namesFragment,
  readDestination,
  readMarkdownLinks,
} from '../src/instructions/markdownLinks.js';

export type DocumentProblemKind =
  | 'broken-link'
  | 'missing-heading'
  | 'missing-path'
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

// Only a comment that opens a line starts an HTML block. An escaped opener or one inside a link
// title is text, so the links after it still render. The block ends at the first `-->`, even
// inside backticks, or at the end of the document.
const htmlCommentBlock = /^ {0,3}<!--[\s\S]*?(?:-->|(?![\s\S]))/gm;

const referenceDefinition = /^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
const notPathCharacter = /[\s<>*?$~{}[\]:@|"'=,()]/;

// The changelog records history, so it may name paths that no longer exist.
const historyFiles = new Set(['CHANGELOG.md']);

const syncedDocumentPrefix = 'docs/stomme/';

// Top-level directories that Tau no longer has, so a path below one is stale rather than a name.
const formerRoots = new Set(['extensions', 'skills']);

const withoutFences = (markdown: string) => markdown.replaceAll(fencedCodeBlock, '');

export const withoutCode = (markdown: string): string =>
  withoutFences(markdown).replaceAll(inlineCode, '');

const linkTargets = (markdown: string) =>
  [...markdown.matchAll(inlineLink), ...markdown.matchAll(referenceDefinition)].map(
    (match) => match[1] ?? match[2] ?? '',
  );

const targetProblem = (
  file: string,
  markdown: string,
  target: string,
  files: Files,
): LinkProblem | undefined => {
  const destination = readDestination(target);

  if (destination.kind === 'external') {
    return undefined;
  }

  if (destination.kind === 'undecodable') {
    return { kind: 'broken-link', detail: `links to undecodable ${target}` };
  }

  const targetFile = destination.path === '' ? file : resolve(dirname(file), destination.path);

  if (!files.exists(targetFile)) {
    return { kind: 'broken-link', detail: `links to missing ${target}` };
  }

  if (destination.fragment === undefined || extname(targetFile) !== '.md') {
    return undefined;
  }

  const fragment = decodedComponent(destination.fragment);
  const targetMarkdown = destination.path === '' ? markdown : files.readMarkdown(targetFile);
  const links = readMarkdownLinks(targetMarkdown);

  if (fragment !== undefined && namesFragment(links, fragment)) {
    return undefined;
  }

  return { kind: 'missing-heading', detail: `links to missing heading ${target}` };
};

export const linkProblems = (file: string, markdown: string, files: Files): LinkProblem[] => {
  const linkableMarkdown = withoutFences(markdown)
    .replaceAll(htmlCommentBlock, '')
    .replaceAll(inlineCode, '');

  return linkTargets(linkableMarkdown).flatMap(
    (target) => targetProblem(file, markdown, target, files) ?? [],
  );
};

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
      const pathPrefix = segments.slice(0, length).join('/');
      paths.add(pathPrefix);
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

    const skipsPaths = historyFiles.has(file) || file.startsWith(syncedDocumentPrefix);
    const paths = skipsPaths ? [] : backtickedPaths(markdown, repositoryPaths);

    for (const path of paths) {
      const allowed = allowedPaths[path]?.includes(file) ?? false;

      named.add(`${file}\0${path}`);

      if (!pathExists(path, repositoryPaths) && !allowed) {
        problems.push({ file, kind: 'missing-path', detail: `names missing path ${path}` });
      }
    }
  }

  const staleEntries = Object.entries(allowedPaths).flatMap(([path, allowedFiles]) =>
    allowedFiles
      .filter((file) => !named.has(`${file}\0${path}`) || pathExists(path, repositoryPaths))
      .map((file) => ({
        file: 'tests/markdownFiles.test.ts',
        kind: 'stale-allowlist' as const,
        detail: `allows ${path} in ${file}, which does not name it as a missing path`,
      })),
  );

  return [...problems, ...staleEntries];
};

// Untracked files count unless Git ignores them, so a new file may be documented before `git add`.
const listRepositoryFiles = (root: string) =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  })
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(root, file)));

export const findDocumentProblems = (
  root: string,
  allowedPaths: AllowedPaths,
): DocumentProblem[] => {
  const allFiles = [...new Set(listRepositoryFiles(root))];

  // stomme generates vendor/, and its guides name paths of the projects that sync them.
  const documents = allFiles
    .filter((file) => file.endsWith('.md') && !file.startsWith('vendor/'))
    .map((file) => ({ file, markdown: readFileSync(join(root, file), 'utf8') }));

  return documentProblems(root, documents, allFiles, allowedPaths);
};
