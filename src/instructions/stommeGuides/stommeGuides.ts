import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
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

const exists = async (path: string): Promise<boolean> => {
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

const ancestors = (start: string): string[] => {
  const folders = [start];

  for (let parent = dirname(start); parent !== folders.at(-1); parent = dirname(parent)) {
    folders.push(parent);
  }

  return folders;
};

// Lists the folders to search, from the working directory up to the top of its repository. Outside
// a repository only the working directory counts.
const searchedFolders = async (cwd: string): Promise<string[]> => {
  const folders = ancestors(cwd);
  const holdsGit = await Promise.all(folders.map((folder) => exists(join(folder, '.git'))));
  const topIndex = holdsGit.indexOf(true);

  return topIndex === -1 ? [cwd] : folders.slice(0, topIndex + 1);
};

const readConfig = async (root: string): Promise<ConfigFact | undefined> => {
  try {
    return { kind: 'text', root, text: await readFile(join(root, configName), 'utf8') };
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    return { kind: 'unreadable', root, error: errorMessage(error) };
  }
};

const findConfig = async (cwd: string, bundleRoot: string): Promise<ConfigFact> => {
  const folders = await searchedFolders(cwd);
  const configs = await Promise.all(folders.map(readConfig));

  return configs.find((config) => config !== undefined) ?? { kind: 'missing', bundleRoot };
};

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
  const selection = await readSelection(resolve(cwd), bundleDirectory);

  if (selection.kind === 'broken') {
    return selection;
  }

  return { ...selection, digest: digestOf(selection) };
};
