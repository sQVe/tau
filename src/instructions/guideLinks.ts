import { posix } from 'node:path';

import { decodedComponent, readDestination, readMarkdownLinks } from './markdownLinks.js';
import type { MarkdownLinks } from './markdownLinks.js';

export type LinkProblem = 'undecodable' | 'leaves-folder' | 'not-synced' | 'missing-heading';

export type GuideLinkCheck =
  | { kind: 'valid' }
  | { kind: 'unreadable'; path: string; error: unknown }
  | { kind: 'broken'; path: string; target: string; problem: LinkProblem };

type ParsedFile = { kind: 'parsed'; links: MarkdownLinks } | { kind: 'unreadable'; error: unknown };

const resolvedPath = (path: string, decodedPath: string) =>
  decodedPath === '' ? path : posix.normalize(posix.join(posix.dirname(path), decodedPath));

const leavesFolder = (decodedPath: string, resolved: string) =>
  decodedPath.startsWith('/') || resolved === '..' || resolved.startsWith('../');

const parsedFile = (text: string): ParsedFile => {
  try {
    return { kind: 'parsed', links: readMarkdownLinks(text) };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
};

const targetCheck = (
  path: string,
  target: string,
  files: ReadonlyMap<string, string>,
  parse: (path: string) => ParsedFile,
): GuideLinkCheck => {
  const destination = readDestination(target);

  if (destination.kind === 'external') {
    return { kind: 'valid' };
  }

  if (destination.kind === 'undecodable') {
    return { kind: 'broken', path, target, problem: 'undecodable' };
  }

  const resolved = resolvedPath(path, destination.path);

  if (leavesFolder(destination.path, resolved)) {
    return { kind: 'broken', path, target, problem: 'leaves-folder' };
  }

  if (!files.has(resolved)) {
    return { kind: 'broken', path, target, problem: 'not-synced' };
  }

  const fragment = destination.fragment;

  if (fragment === undefined || fragment === '' || !resolved.endsWith('.md')) {
    return { kind: 'valid' };
  }

  const slug = decodedComponent(fragment);

  if (slug === undefined) {
    return { kind: 'broken', path, target, problem: 'undecodable' };
  }

  const parsed = parse(resolved);

  if (parsed.kind === 'unreadable') {
    return { kind: 'unreadable', path: resolved, error: parsed.error };
  }

  return parsed.links.slugs.has(slug)
    ? { kind: 'valid' }
    : { kind: 'broken', path, target, problem: 'missing-heading' };
};

export const checkGuideLinks = (files: ReadonlyMap<string, string>): GuideLinkCheck => {
  const cache = new Map<string, ParsedFile>();

  const parse = (path: string): ParsedFile => {
    const cached = cache.get(path);

    if (cached !== undefined) {
      return cached;
    }

    const text = files.get(path);

    if (text === undefined) {
      return { kind: 'unreadable', error: new Error(`${path} is not in the record`) };
    }

    const parsed = parsedFile(text);

    cache.set(path, parsed);

    return parsed;
  };

  for (const path of files.keys()) {
    if (!path.endsWith('.md')) {
      continue;
    }

    const parsed = parse(path);

    if (parsed.kind === 'unreadable') {
      return { kind: 'unreadable', path, error: parsed.error };
    }

    for (const target of parsed.links.targets) {
      const check = targetCheck(path, target, files, parse);

      if (check.kind !== 'valid') {
        return check;
      }
    }
  }

  return { kind: 'valid' };
};
