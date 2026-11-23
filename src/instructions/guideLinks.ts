import { posix } from 'node:path';

import { decodedComponent, readDestination, readMarkdownLinks } from './markdownLinks.js';
import type { MarkdownLinks } from './markdownLinks.js';

export type GuideLinkCheck =
  | { kind: 'valid' }
  | { kind: 'unreadable'; path: string; error: unknown }
  | { kind: 'broken'; path: string; problem: string };

type IndexedFile = { kind: 'other' } | { kind: 'markdown'; links: MarkdownLinks };
type GuideIndex = ReadonlyMap<string, IndexedFile>;

const resolvedPath = (path: string, decodedPath: string) =>
  decodedPath === '' ? path : posix.normalize(posix.join(posix.dirname(path), decodedPath));

const leavesFolder = (decodedPath: string, resolved: string) =>
  decodedPath.startsWith('/') || resolved === '..' || resolved.startsWith('../');

const fragmentProblem = (
  target: string,
  fragment: string | undefined,
  entry: IndexedFile,
): string | undefined => {
  if (fragment === undefined || fragment === '' || entry.kind === 'other') {
    return undefined;
  }

  const slug = decodedComponent(fragment);

  if (slug !== undefined && entry.links.slugs.has(slug)) {
    return undefined;
  }

  return `links to ${target}, which names a missing heading`;
};

const targetProblem = (path: string, target: string, index: GuideIndex): string | undefined => {
  const destination = readDestination(target);

  if (destination.kind === 'external') {
    return undefined;
  }

  if (destination.kind === 'undecodable') {
    return `links to ${target}, which cannot be decoded`;
  }

  const resolved = resolvedPath(path, destination.path);

  if (leavesFolder(destination.path, resolved)) {
    return `links to ${target}, which leaves the synced folder`;
  }

  const entry = index.get(resolved);

  if (entry === undefined) {
    return `links to ${target}, which is not a synced file`;
  }

  return fragmentProblem(target, destination.fragment, entry);
};

const indexFile = (path: string, text: string): IndexedFile =>
  path.endsWith('.md') ? { kind: 'markdown', links: readMarkdownLinks(text) } : { kind: 'other' };

export const checkGuideLinks = (files: ReadonlyMap<string, string>): GuideLinkCheck => {
  const index = new Map<string, IndexedFile>();

  for (const [path, text] of files) {
    try {
      index.set(path, indexFile(path, text));
    } catch (error) {
      return { kind: 'unreadable', path, error };
    }
  }

  for (const [path, entry] of index) {
    if (entry.kind === 'other') {
      continue;
    }

    for (const target of entry.links.targets) {
      const problem = targetProblem(path, target, index);

      if (problem !== undefined) {
        return { kind: 'broken', path, problem };
      }
    }
  }

  return { kind: 'valid' };
};
