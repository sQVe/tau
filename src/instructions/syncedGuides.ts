import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.js';
import { readMarkdownLinks } from './markdownLinks.js';
import type { MarkdownLinks } from './markdownLinks.js';
import { readRegularFile } from './regularFile.js';
import { parseSyncRecord } from './syncRecord.js';
import type { SyncRecord } from './syncRecord.js';

export interface GuideFileSystem {
  readFile: (path: string) => Promise<Uint8Array>;
  lstat: (path: string) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean }>;
}

export type SyncedGuides =
  | { kind: 'valid'; version: string; files: ReadonlyMap<string, string> }
  | { kind: 'broken'; reason: string };

type TextRead = { text: string; bytes: Uint8Array } | { reason: string };

const recordName = '.sync-record.toml';
const fix = 'run stomme sync';

const urlScheme = /^[a-z][a-z\d+.-]*:/i;

const broken = (reason: string): SyncedGuides => ({ kind: 'broken', reason });

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const readText = async (file: string, fileSystem: GuideFileSystem): Promise<TextRead> => {
  try {
    const bytes = await fileSystem.readFile(file);

    return { bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
  } catch (error) {
    const reason = isMissingFile(error)
      ? `${file} is missing; ${fix}`
      : `${file} cannot be read: ${errorMessage(error)}; ${fix}`;

    return { reason };
  }
};

const firstLinkedFolder = async (
  folders: readonly string[],
  fileSystem: GuideFileSystem,
): Promise<string | undefined> => {
  const stats = await Promise.all(
    folders.map((folder) => fileSystem.lstat(folder).catch(() => undefined)),
  );

  const linkIndex = stats.findIndex((folderStats) => folderStats?.isSymbolicLink() === true);
  const link = folders[linkIndex];

  return link === undefined
    ? undefined
    : `${link} is a symbolic link; replace it with the folder and ${fix}`;
};

const linkedFolder = async (
  directory: string,
  path: string,
  fileSystem: GuideFileSystem,
): Promise<string | undefined> => {
  const segments = path.split('/').slice(0, -1);
  const folders = segments.map((_, index) => join(directory, ...segments.slice(0, index + 1)));

  return firstLinkedFolder(folders, fileSystem);
};

const readGuide = async (
  directory: string,
  path: string,
  hash: string,
  fileSystem: GuideFileSystem,
): Promise<TextRead> => {
  const linked = await linkedFolder(directory, path, fileSystem);

  if (linked !== undefined) {
    return { reason: linked };
  }

  const file = join(directory, path);
  const stats = await fileSystem.lstat(file).catch(() => undefined);

  if (stats?.isSymbolicLink() === true) {
    return { reason: `${file} is a symbolic link; replace it with the file and ${fix}` };
  }

  if (stats?.isFile() === false) {
    return { reason: `${file} is not a file; replace it with the file and ${fix}` };
  }

  const read = await readText(file, fileSystem);

  if ('text' in read && sha256(read.bytes) !== hash) {
    return { reason: `${file} differs from its record; ${fix}` };
  }

  return read;
};

const targetParts = (target: string) => {
  const fragmentStart = target.indexOf('#');
  const reference = fragmentStart === -1 ? target : target.slice(0, fragmentStart);
  const queryStart = reference.indexOf('?');

  return {
    encodedPath: queryStart === -1 ? reference : reference.slice(0, queryStart),
    fragment: fragmentStart === -1 ? undefined : target.slice(fragmentStart + 1),
  };
};

const decoded = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

const resolvedPath = (path: string, decodedPath: string) =>
  decodedPath === '' ? path : posix.normalize(posix.join(posix.dirname(path), decodedPath));

const leavesFolder = (decodedPath: string, resolved: string) =>
  decodedPath.startsWith('/') || resolved === '..' || resolved.startsWith('../');

const fragmentProblem = (
  target: string,
  fragment: string | undefined,
  resolved: string,
  links: ReadonlyMap<string, MarkdownLinks>,
): string | undefined => {
  if (fragment === undefined || fragment === '' || !resolved.endsWith('.md')) {
    return undefined;
  }

  const slug = decoded(fragment);

  if (slug !== undefined && links.get(resolved)?.slugs.has(slug) === true) {
    return undefined;
  }

  return `links to ${target}, which names a missing heading`;
};

const linkProblem = (
  path: string,
  target: string,
  links: ReadonlyMap<string, MarkdownLinks>,
  recorded: ReadonlyMap<string, string>,
): string | undefined => {
  if (urlScheme.test(target)) {
    return undefined;
  }

  const { encodedPath, fragment } = targetParts(target);
  const decodedPath = decoded(encodedPath);

  if (decodedPath === undefined) {
    return `links to ${target}, which cannot be decoded`;
  }

  const resolved = resolvedPath(path, decodedPath);

  if (leavesFolder(decodedPath, resolved)) {
    return `links to ${target}, which leaves the synced folder`;
  }

  if (!recorded.has(resolved)) {
    return `links to ${target}, which is not a synced file`;
  }

  return fragmentProblem(target, fragment, resolved, links);
};

const firstLinkProblem = (
  directory: string,
  files: ReadonlyMap<string, string>,
): string | undefined => {
  const links = new Map<string, MarkdownLinks>();

  for (const [path, text] of files) {
    if (!path.endsWith('.md')) {
      continue;
    }

    try {
      links.set(path, readMarkdownLinks(text));
    } catch (error) {
      return `${join(directory, path)} cannot be read as Markdown: ${errorMessage(error)}`;
    }
  }

  for (const path of files.keys()) {
    const targets = links.get(path)?.targets ?? [];

    const problem = targets.map((target) => linkProblem(path, target, links, files)).find(Boolean);

    if (problem !== undefined) {
      return `${join(directory, path)} ${problem}; ${fix}`;
    }
  }

  return undefined;
};

const readRecordedGuides = async (
  directory: string,
  record: SyncRecord,
  fileSystem: GuideFileSystem,
): Promise<SyncedGuides> => {
  const files = new Map<string, string>();

  for (const [path, hash] of record.files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The first broken file ends the read.
    const guide = await readGuide(directory, path, hash, fileSystem);

    if ('reason' in guide) {
      return broken(guide.reason);
    }

    files.set(path, guide.text);
  }

  const problem = firstLinkProblem(directory, files);

  return problem === undefined
    ? { kind: 'valid', version: record.version, files }
    : broken(problem);
};

const readAgainstRecord = async (
  directory: string,
  recordText: string,
  fileSystem: GuideFileSystem,
): Promise<SyncedGuides> => {
  let record: SyncRecord;

  try {
    record = parseSyncRecord(recordText);
  } catch (error) {
    return broken(`${join(directory, recordName)} ${errorMessage(error)}`);
  }

  return readRecordedGuides(directory, record, fileSystem);
};

const readOnce = async (
  directory: string,
  fileSystem: GuideFileSystem,
): Promise<SyncedGuides | undefined> => {
  const recordFile = join(directory, recordName);
  const before = await readText(recordFile, fileSystem);

  if ('reason' in before) {
    return broken(before.reason);
  }

  const guides = await readAgainstRecord(directory, before.text, fileSystem);
  const after = await readText(recordFile, fileSystem);

  if ('reason' in after) {
    return broken(after.reason);
  }

  return after.text === before.text ? guides : undefined;
};

const nodeFileSystem: GuideFileSystem = { readFile: readRegularFile, lstat };

// The caller lists the folders above `directory` that must not be links, such as `docs`. Folders
// further up stay free to be links.
export const readSyncedGuides = async (
  directory: string,
  checkedParents: readonly string[] = [],
  fileSystem: GuideFileSystem = nodeFileSystem,
): Promise<SyncedGuides> => {
  const linked = await firstLinkedFolder([...checkedParents, directory], fileSystem);

  if (linked !== undefined) {
    return broken(linked);
  }

  const first = await readOnce(directory, fileSystem);

  if (first !== undefined) {
    return first;
  }

  const second = await readOnce(directory, fileSystem);
  const recordFile = join(directory, recordName);

  return second ?? broken(`${recordFile} changed twice while Tau read it; ${fix} and try again`);
};
