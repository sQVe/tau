import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GuideLanguage } from '../src/instructions/stommeGuides/stommeGuidesDecision.js';

interface StommeProjectOptions {
  version?: string;
  language: GuideLanguage;
  layers?: string[];
  recordedLayers?: string[];
}

const bundleDirectory = fileURLToPath(new URL('../vendor/stomme', import.meta.url));

const listFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
};

const recordText = async (
  syncedDirectory: string,
  version: string,
  guides: readonly string[],
): Promise<string> => {
  const lines = ['schema = 1', `version = "${version}"`, '', '[files]'];

  for (const path of guides.toSorted()) {
    const hash = createHash('sha256')
      .update(await readFile(join(syncedDirectory, path)))
      .digest('hex');

    lines.push(`"${path}" = "${hash}"`);
  }

  return `${lines.join('\n')}\n`;
};

const copyGuide = async (path: string, syncedDirectory: string): Promise<void> => {
  const target = join(syncedDirectory, path);

  await mkdir(dirname(target), { recursive: true });
  await cp(join(bundleDirectory, path), target);
};

const configText = (version: string, language: GuideLanguage, layers: string[]): string => {
  const layerList = layers.map((layer) => `"${layer}"`).join(', ');

  return [
    'schema = 1',
    `version = "${version}"`,
    `language = "${language}"`,
    `layers = [${layerList}]`,
    '',
  ].join('\n');
};

export const writeStommeProject = async (
  directory: string,
  options: StommeProjectOptions,
): Promise<void> => {
  const { version = '0.2.0', language, layers = [], recordedLayers = [] } = options;
  const syncedDirectory = join(directory, 'docs', 'stomme');

  const sharedGuides = (await listFiles(join(bundleDirectory, 'shared'))).map((path) =>
    join('shared', path),
  );

  const layerGuides = [...layers, ...recordedLayers].map((layer) =>
    join('layers', layer, 'guide.md'),
  );

  const guides = [
    ...new Set([...sharedGuides, join('languages', language, 'guide.md'), ...layerGuides]),
  ];

  await rm(syncedDirectory, { recursive: true, force: true });

  for (const path of guides) {
    await copyGuide(path, syncedDirectory);
  }

  await writeFile(
    join(syncedDirectory, '.sync-record.toml'),
    await recordText(syncedDirectory, version, guides),
  );

  await writeFile(join(directory, 'stomme.toml'), configText(version, language, layers));
};
