import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.js';
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

// Matches the spans that are not rendered as a link, in document order, so one span cannot hide
// another: a fence inside an HTML comment stays comment text, and a link after it still renders.
// Inline code ends at a blank line or a fence, so it cannot reach into a later block. The last two
// alternatives capture an inline link target and a reference definition target.
const markdownToken =
  /<!--[\s\S]*?(?:-->|(?![\s\S]))|^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))|(`+)(?:(?!\n[ \t]*(?:\n|`{3,}|~{3,}))[\s\S])*?\2|\]\(\s*(?:<([^>\n]*)>|([^)\s]+))|^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;

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

const linkedFolder = async (
  directory: string,
  path: string,
  fileSystem: GuideFileSystem,
): Promise<string | undefined> => {
  const segments = path.split('/').slice(0, -1);
  const folders = segments.map((_, index) => join(directory, ...segments.slice(0, index + 1)));

  const stats = await Promise.all(
    folders.map((folder) => fileSystem.lstat(folder).catch(() => undefined)),
  );

  const linkIndex = stats.findIndex((folderStats) => folderStats?.isSymbolicLink() === true);
  const link = folders[linkIndex];

  return link === undefined
    ? undefined
    : `${link} is a symbolic link; replace it with the folder and ${fix}`;
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

const linkTargets = (markdown: string): string[] =>
  [...markdown.matchAll(markdownToken)].flatMap((match) => {
    const inlineTarget = match[3] ?? match[4];
    const definitionTarget = match[5] ?? match[6];

    return inlineTarget ?? definitionTarget ?? [];
  });

const linkProblem = (
  path: string,
  target: string,
  recorded: ReadonlyMap<string, string>,
): string | undefined => {
  const [targetPath = ''] = target.split('#');

  if (targetPath === '' || urlScheme.test(target)) {
    return undefined;
  }

  const resolved = posix.normalize(posix.join(posix.dirname(path), targetPath));

  const leavesFolder =
    targetPath.startsWith('/') || resolved === '..' || resolved.startsWith('../');

  if (leavesFolder) {
    return `links to ${target}, which leaves the synced folder`;
  }

  return recorded.has(resolved) ? undefined : `links to ${target}, which is not a synced file`;
};

const firstLinkProblem = (
  directory: string,
  files: ReadonlyMap<string, string>,
): string | undefined => {
  for (const [path, text] of files) {
    const targets = path.endsWith('.md') ? linkTargets(text) : [];
    const problem = targets.map((target) => linkProblem(path, target, files)).find(Boolean);

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

export const readSyncedGuides = async (
  directory: string,
  fileSystem: GuideFileSystem = nodeFileSystem,
): Promise<SyncedGuides> => {
  const first = await readOnce(directory, fileSystem);

  if (first !== undefined) {
    return first;
  }

  const second = await readOnce(directory, fileSystem);
  const recordFile = join(directory, recordName);

  return second ?? broken(`${recordFile} changed twice while Tau read it; ${fix} and try again`);
};
