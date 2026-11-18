import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.js';
import { parseSyncRecord } from './syncRecord.js';
import type { SyncRecord } from './syncRecord.js';

export interface GuideFileSystem {
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  lstat: (path: string) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean }>;
}

export type SyncedGuides =
  | { kind: 'valid'; version: string; files: ReadonlyMap<string, string> }
  | { kind: 'broken'; reason: string };

type TextRead = { text: string } | { reason: string };

const recordName = '.sync-record.toml';
const fix = 'run stomme sync';

// Text in these spans is not rendered as a link.
const fencedCode = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const htmlComment = /<!--[\s\S]*?(?:-->|(?![\s\S]))/g;
const inlineCode = /(`+)[\s\S]*?\1/g;

const inlineLink = /\]\(\s*<?([^)\s>]+)/g;
const urlScheme = /^[a-z][a-z\d+.-]*:/i;

const broken = (reason: string): SyncedGuides => ({ kind: 'broken', reason });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const readText = async (file: string, fileSystem: GuideFileSystem): Promise<TextRead> => {
  try {
    return { text: await fileSystem.readFile(file, 'utf8') };
  } catch (error) {
    const reason = isMissingFile(error)
      ? `${file} is missing; ${fix}`
      : `${file} cannot be read: ${errorMessage(error)}`;

    return { reason };
  }
};

const readGuide = async (
  file: string,
  hash: string,
  fileSystem: GuideFileSystem,
): Promise<TextRead> => {
  const stats = await fileSystem.lstat(file).catch(() => undefined);

  if (stats?.isSymbolicLink() === true) {
    return { reason: `${file} is a symbolic link; replace it with the file and ${fix}` };
  }

  if (stats?.isFile() === false) {
    return { reason: `${file} is not a file; replace it with the file and ${fix}` };
  }

  const read = await readText(file, fileSystem);

  if ('text' in read && sha256(read.text) !== hash) {
    return { reason: `${file} differs from its record; ${fix}` };
  }

  return read;
};

const linkTargets = (markdown: string): string[] => {
  const rendered = markdown
    .replaceAll(fencedCode, '')
    .replaceAll(htmlComment, '')
    .replaceAll(inlineCode, '');

  return [...rendered.matchAll(inlineLink)].flatMap(([, target]) => target ?? []);
};

// Names what is wrong with one link target, or nothing when it resolves to a recorded file.
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
    const guide = await readGuide(join(directory, path), hash, fileSystem);

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

// Returns nothing when the record changed during the read, so the result may mix two syncs.
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
  const isUnchanged = 'text' in after && after.text === before.text;

  return isUnchanged ? guides : undefined;
};

const nodeFileSystem: GuideFileSystem = { readFile, lstat };

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
