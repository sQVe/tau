import { join } from 'node:path';

import { parse } from 'smol-toml';

import type { SyncedGuides } from '../syncedGuides.js';

export type GuideLanguage = 'rust' | 'typescript';

export interface Guide {
  path: string;
  text: string;
}

export type ConfigFact =
  | { kind: 'missing'; bundleRoot: string }
  | { kind: 'unreadable'; root: string; error: string }
  | { kind: 'text'; root: string; text: string };

export type GuideSelection =
  | {
      kind: 'project';
      root: string;
      version: string;
      language: GuideLanguage;
      layers: string[];
      guides: Guide[];
    }
  | {
      kind: 'bundle';
      root: string;
      version: string;
      guides: Guide[];
      languageGuides: Record<GuideLanguage, Guide>;
    }
  | { kind: 'broken'; root: string; reason: string };

interface Pin {
  version: string;
  language: GuideLanguage;
  layers: string[];
}

type Table = Readonly<Record<string, unknown>>;

type GuideLookup = { guides: Guide[] } | { missing: string };

const generalGuide = 'shared/coding.md';
const languages: readonly GuideLanguage[] = ['rust', 'typescript'];
const configName = 'stomme.toml';
const syncedFolder = 'docs/stomme';

const languageGuidePath = (language: GuideLanguage) => `languages/${language}/guide.md`;

const isLanguage = (value: unknown): value is GuideLanguage =>
  languages.some((language) => language === value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const brokenAt = (root: string, reason: string): GuideSelection => ({
  kind: 'broken',
  root,
  reason,
});

const guideAt = (files: ReadonlyMap<string, string>, path: string): Guide | undefined => {
  const text = files.get(path);

  return text === undefined ? undefined : { path, text };
};

const lookUp = (files: ReadonlyMap<string, string>, paths: readonly string[]): GuideLookup => {
  const guides: Guide[] = [];

  for (const path of paths) {
    const guide = guideAt(files, path);

    if (guide === undefined) {
      return { missing: path };
    }

    guides.push(guide);
  }

  return { guides };
};

const missingFromBundle = (bundleRoot: string, path: string): GuideSelection =>
  brokenAt(bundleRoot, `The bundle has no ${path} in its record; regenerate it`);

const parseTable = (text: string): Table => {
  try {
    return parse(text, { integersAsBigInt: true });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : error;
    const [firstLine = ''] = String(rawMessage).split('\n');

    throw new Error(`is not valid TOML: ${firstLine}`, { cause: error });
  }
};

const readPin = (text: string): Pin => {
  const table = parseTable(text);
  const { schema, version, language, layers = [] } = table;

  if (schema !== 1n) {
    throw new Error('needs `schema = 1`');
  }

  if (typeof version !== 'string' || version === '') {
    throw new Error('needs a `version` string, such as `version = "0.2.0"`');
  }

  if (!isLanguage(language)) {
    throw new Error('needs `language = "rust"` or `language = "typescript"`');
  }

  if (!isStringArray(layers)) {
    throw new Error('needs `layers` to be an array of strings');
  }

  const repeated = layers.find((layer, index) => layers.indexOf(layer) !== index);

  if (repeated !== undefined) {
    throw new Error(`lists the layer \`${repeated}\` more than once`);
  }

  return { version, language, layers: layers.toSorted() };
};

const decideProject = (
  root: string,
  text: string,
  synced: SyncedGuides | undefined,
): GuideSelection => {
  const file = join(root, configName);
  let pin: Pin;

  try {
    pin = readPin(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return brokenAt(root, `${file} ${message}`);
  }

  if (synced === undefined) {
    return brokenAt(root, `The guides of ${root} were not read`);
  }

  if (synced.kind === 'broken') {
    return brokenAt(root, synced.reason);
  }

  if (synced.version !== pin.version) {
    return brokenAt(
      root,
      `${syncedFolder} holds stomme ${synced.version}, but ${configName} pins ${pin.version}; run stomme sync`,
    );
  }

  const paths = [
    generalGuide,
    languageGuidePath(pin.language),
    ...pin.layers.map((layer) => `layers/${layer}/guide.md`),
  ];

  const lookup = lookUp(synced.files, paths);

  if ('missing' in lookup) {
    return brokenAt(
      root,
      `${syncedFolder} has no ${lookup.missing} in its record, so ${configName} cannot use it; run stomme sync`,
    );
  }

  return { kind: 'project', root, ...pin, guides: lookup.guides };
};

const decideBundle = (bundleRoot: string, bundle: SyncedGuides | undefined): GuideSelection => {
  if (bundle === undefined) {
    return brokenAt(bundleRoot, 'The bundle was not read');
  }

  if (bundle.kind === 'broken') {
    return brokenAt(bundleRoot, bundle.reason);
  }

  const general = guideAt(bundle.files, generalGuide);
  const rust = guideAt(bundle.files, languageGuidePath('rust'));
  const typescript = guideAt(bundle.files, languageGuidePath('typescript'));

  if (general === undefined) {
    return missingFromBundle(bundleRoot, generalGuide);
  }

  if (rust === undefined) {
    return missingFromBundle(bundleRoot, languageGuidePath('rust'));
  }

  if (typescript === undefined) {
    return missingFromBundle(bundleRoot, languageGuidePath('typescript'));
  }

  return {
    kind: 'bundle',
    root: bundleRoot,
    version: bundle.version,
    guides: [general],
    languageGuides: { rust, typescript },
  };
};

export const decideGuides = (
  config: ConfigFact,
  synced: SyncedGuides | undefined,
  bundle: SyncedGuides | undefined,
): GuideSelection => {
  if (config.kind === 'missing') {
    return decideBundle(config.bundleRoot, bundle);
  }

  if (config.kind === 'unreadable') {
    const file = join(config.root, configName);

    return brokenAt(config.root, `${file} cannot be read: ${config.error}`);
  }

  return decideProject(config.root, config.text, synced);
};
