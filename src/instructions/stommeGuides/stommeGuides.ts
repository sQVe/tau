import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage, isMissingFile } from '../../errors.js';
import { readSyncedGuides } from '../syncedGuides.js';
import type { SyncedGuides } from '../syncedGuides.js';
import { decideGuides } from './stommeGuidesDecision.js';
import type { ConfigFact, Guide, GuideSelection } from './stommeGuidesDecision.js';

export type GuideSnapshot =
  | (Exclude<GuideSelection, { kind: 'broken' }> & { digest: string })
  | Extract<GuideSelection, { kind: 'broken' }>;

const configName = 'stomme.toml';
const defaultBundleDirectory = fileURLToPath(new URL('../../../vendor/stomme', import.meta.url));

const isPresent = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
};

// Finds the top of the repository by probing `.git` upward, and stops at the first one. A probe
// that fails for another reason than a missing entry rejects.
const findRepositoryTop = async (folder: string): Promise<string | undefined> => {
  if (await isPresent(join(folder, '.git'))) {
    return folder;
  }

  const parent = dirname(folder);

  return parent === folder ? undefined : findRepositoryTop(parent);
};

const foldersBetween = (start: string, top: string): string[] => {
  const parent = dirname(start);

  return start === top || parent === start ? [start] : [start, ...foldersBetween(parent, top)];
};

// Lists the folders to search, from the working directory up to the top of its repository. Outside
// a repository only the working directory counts.
const searchedFolders = async (cwd: string): Promise<string[]> => {
  const top = await findRepositoryTop(cwd);

  return top === undefined ? [cwd] : foldersBetween(cwd, top);
};

const readConfigText = async (root: string): Promise<ConfigFact> => {
  const file = join(root, configName);
  let handle: FileHandle | undefined;

  try {
    // A pipe opens without a writer only in non-blocking mode. The type check and the read use
    // this one handle, so the path cannot change between them.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);

    const stats = await handle.stat();

    if (!stats.isFile()) {
      return { kind: 'unreadable', root, error: 'it is not a regular file' };
    }

    return { kind: 'text', root, text: await handle.readFile('utf8') };
  } catch (error) {
    return { kind: 'unreadable', root, error: errorMessage(error) };
  } finally {
    await handle?.close();
  }
};

// A present entry that cannot be used is an error. Only an absent entry lets the walk go on.
const readConfig = async (root: string): Promise<ConfigFact | undefined> => {
  try {
    if (!(await isPresent(join(root, configName)))) {
      return undefined;
    }
  } catch (error) {
    return { kind: 'unreadable', root, error: errorMessage(error) };
  }

  return readConfigText(root);
};

const findConfigIn = async (
  folders: readonly string[],
  bundleRoot: string,
): Promise<ConfigFact> => {
  const [folder, ...rest] = folders;

  if (folder === undefined) {
    return { kind: 'missing', bundleRoot };
  }

  return (await readConfig(folder)) ?? findConfigIn(rest, bundleRoot);
};

const findConfig = async (cwd: string, bundleRoot: string): Promise<ConfigFact> =>
  findConfigIn(await searchedFolders(cwd), bundleRoot);

const readSelection = async (cwd: string, bundleRoot: string): Promise<GuideSelection> => {
  const config = await findConfig(cwd, bundleRoot);
  let synced: SyncedGuides | undefined;
  let bundle: SyncedGuides | undefined;

  if (config.kind === 'text') {
    synced = await readSyncedGuides(join(config.root, 'docs', 'stomme'));
  }

  if (config.kind === 'missing') {
    bundle = await readSyncedGuides(bundleRoot);
  }

  return decideGuides(config, synced, bundle);
};

const frame = (value: string): string => `${Buffer.byteLength(value)}:${value}`;

const guideFields = (guides: readonly Guide[]): string[] =>
  guides.flatMap((guide) => [guide.path, guide.text]);

const digestFields = (selection: Exclude<GuideSelection, { kind: 'broken' }>): string[] => {
  if (selection.kind === 'project') {
    return [
      selection.kind,
      selection.version,
      selection.language,
      selection.layers.join(','),
      ...guideFields(selection.guides),
    ];
  }

  const { typescript, rust } = selection.languageGuides;

  return [
    selection.kind,
    selection.version,
    '',
    '',
    ...guideFields(selection.guides),
    ...guideFields([typescript, rust]),
  ];
};

const digestOf = (selection: Exclude<GuideSelection, { kind: 'broken' }>): string => {
  const hash = createHash('sha256');

  for (const field of digestFields(selection)) {
    hash.update(frame(field));
  }

  return hash.digest('hex');
};

export const resolveStommeGuides = async (
  cwd: string,
  bundleDirectory: string = defaultBundleDirectory,
): Promise<GuideSnapshot> => {
  const start = resolve(cwd);

  try {
    const selection = await readSelection(start, bundleDirectory);

    return selection.kind === 'broken' ? selection : { ...selection, digest: digestOf(selection) };
  } catch (error) {
    return {
      kind: 'broken',
      root: start,
      reason: `${start} cannot be read: ${errorMessage(error)}`,
    };
  }
};
