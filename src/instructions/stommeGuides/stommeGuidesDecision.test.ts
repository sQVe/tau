import { expect, it } from 'vitest';

import type { SyncedGuides } from '../syncedGuides.js';
import { planGuides, selectBundleGuides, selectProjectGuides } from './stommeGuidesDecision.js';
import type { ConfigFact, GuidePlan, GuideSelection, Pin } from './stommeGuidesDecision.js';

const root = '/project';
const bundleRoot = '/tau/vendor/stomme';

const synced = (version: string, paths: string[]): SyncedGuides => ({
  kind: 'valid',
  version,
  files: new Map(paths.map((path) => [path, `text of ${path}`])),
});

const guide = (path: string) => ({ path, text: `text of ${path}` });

const allGuides = [
  'shared/coding.md',
  'languages/rust/guide.md',
  'languages/typescript/guide.md',
  'layers/gpui/guide.md',
  'layers/react/guide.md',
];

const without = (missing: string) => allGuides.filter((path) => path !== missing);

const config = (...lines: string[]): ConfigFact => ({
  kind: 'text',
  root,
  text: lines.join('\n'),
});

const rustConfig = (...extra: string[]) =>
  config('schema = 1', 'version = "0.2.0"', 'language = "rust"', ...extra);

const broken = (reason: string) => ({ kind: 'broken' as const, root, reason });

const readProject = (pin: Pin): GuidePlan => ({ kind: 'readProject', root, pin });

const rustPin: Pin = { version: '0.2.0', language: 'rust', layers: [] };

const missingConfig: ConfigFact = { kind: 'missing', bundleRoot };

const brokenAtBundle = (reason: string) => ({
  kind: 'broken' as const,
  root: bundleRoot,
  reason,
});

const planTable: { name: string; config: ConfigFact; expected: GuidePlan }[] = [
  {
    name: 'plans a Rust project with the gpui layer',
    config: rustConfig('layers = ["gpui"]'),
    expected: readProject({ ...rustPin, layers: ['gpui'] }),
  },
  {
    name: 'plans a TypeScript project without layers',
    config: config('schema = 1', 'version = "0.2.0"', 'language = "typescript"'),
    expected: readProject({ version: '0.2.0', language: 'typescript', layers: [] }),
  },
  {
    name: 'orders layers by name',
    config: rustConfig('layers = ["react", "gpui"]'),
    expected: readProject({ ...rustPin, layers: ['gpui', 'react'] }),
  },
  {
    name: 'ignores keys it does not read',
    config: rustConfig('profile = 7', '[checks]', 'strict = true'),
    expected: readProject(rustPin),
  },
  {
    name: 'reads the bundle without stomme.toml',
    config: missingConfig,
    expected: { kind: 'readBundle', bundleRoot },
  },
  {
    name: 'rejects an unreadable configuration',
    config: { kind: 'unreadable', root, error: 'EACCES: permission denied' },
    expected: broken('/project/stomme.toml cannot be read: EACCES: permission denied'),
  },
  {
    name: 'rejects a missing schema',
    config: config('version = "0.2.0"', 'language = "rust"'),
    expected: broken('/project/stomme.toml needs `schema = 1`'),
  },
  {
    name: 'rejects another schema',
    config: config('schema = 2', 'version = "0.2.0"', 'language = "rust"'),
    expected: broken('/project/stomme.toml needs `schema = 1`'),
  },
  {
    name: 'rejects a schema that is not an integer',
    config: config('schema = "1"', 'version = "0.2.0"', 'language = "rust"'),
    expected: broken('/project/stomme.toml needs `schema = 1`'),
  },
  {
    name: 'rejects a missing version',
    config: config('schema = 1', 'language = "rust"'),
    expected: broken('/project/stomme.toml needs a `version` string, such as `version = "0.2.0"`'),
  },
  {
    name: 'rejects an empty version',
    config: config('schema = 1', 'version = ""', 'language = "rust"'),
    expected: broken('/project/stomme.toml needs a `version` string, such as `version = "0.2.0"`'),
  },
  {
    name: 'rejects a version that is not a string',
    config: config('schema = 1', 'version = 2', 'language = "rust"'),
    expected: broken('/project/stomme.toml needs a `version` string, such as `version = "0.2.0"`'),
  },
  {
    name: 'rejects a missing language',
    config: config('schema = 1', 'version = "0.2.0"'),
    expected: broken('/project/stomme.toml needs `language = "rust"` or `language = "typescript"`'),
  },
  {
    name: 'rejects another language',
    config: config('schema = 1', 'version = "0.2.0"', 'language = "python"'),
    expected: broken('/project/stomme.toml needs `language = "rust"` or `language = "typescript"`'),
  },
  {
    name: 'rejects layers that are not an array',
    config: rustConfig('layers = "gpui"'),
    expected: broken('/project/stomme.toml needs `layers` to be an array of strings'),
  },
  {
    name: 'rejects a layer that is not a string',
    config: rustConfig('layers = ["gpui", 3]'),
    expected: broken('/project/stomme.toml needs `layers` to be an array of strings'),
  },
  {
    name: 'rejects duplicate layers',
    config: rustConfig('layers = ["gpui", "react", "gpui"]'),
    expected: broken('/project/stomme.toml lists the layer `gpui` more than once'),
  },
  {
    name: 'rejects invalid TOML',
    config: config('schema = ='),
    expected: {
      kind: 'broken',
      root,
      reason: expect.stringMatching(
        /^\/project\/stomme\.toml is not valid TOML: [^\n]{2,}$/,
      ) as string,
    },
  },
];

const projectTable: { name: string; pin: Pin; synced: SyncedGuides; expected: GuideSelection }[] = [
  {
    name: 'selects a Rust project with the gpui layer',
    pin: { ...rustPin, layers: ['gpui'] },
    synced: synced('0.2.0', allGuides),
    expected: {
      kind: 'project',
      root,
      version: '0.2.0',
      language: 'rust',
      layers: ['gpui'],
      guides: [
        guide('shared/coding.md'),
        guide('languages/rust/guide.md'),
        guide('layers/gpui/guide.md'),
      ],
    },
  },
  {
    name: 'selects a TypeScript project without layers',
    pin: { version: '0.2.0', language: 'typescript', layers: [] },
    synced: synced('0.2.0', allGuides),
    expected: {
      kind: 'project',
      root,
      version: '0.2.0',
      language: 'typescript',
      layers: [],
      guides: [guide('shared/coding.md'), guide('languages/typescript/guide.md')],
    },
  },
  {
    name: 'lists layer guides in pin order',
    pin: { ...rustPin, layers: ['gpui', 'react'] },
    synced: synced('0.2.0', allGuides),
    expected: {
      kind: 'project',
      root,
      version: '0.2.0',
      language: 'rust',
      layers: ['gpui', 'react'],
      guides: [
        guide('shared/coding.md'),
        guide('languages/rust/guide.md'),
        guide('layers/gpui/guide.md'),
        guide('layers/react/guide.md'),
      ],
    },
  },
  {
    name: 'passes a broken synced folder through',
    pin: rustPin,
    synced: { kind: 'broken', reason: '/project/docs/stomme is damaged' },
    expected: broken('/project/docs/stomme is damaged'),
  },
  {
    name: 'rejects synced guides of another version',
    pin: rustPin,
    synced: synced('0.1.0', allGuides),
    expected: broken('docs/stomme holds stomme 0.1.0, but stomme.toml pins 0.2.0; run stomme sync'),
  },
  {
    name: 'rejects a record without the general guide',
    pin: rustPin,
    synced: synced('0.2.0', without('shared/coding.md')),
    expected: broken(
      'docs/stomme has no shared/coding.md in its record, so stomme.toml cannot use it; run stomme sync',
    ),
  },
  {
    name: 'rejects a record without the language guide',
    pin: rustPin,
    synced: synced('0.2.0', without('languages/rust/guide.md')),
    expected: broken(
      'docs/stomme has no languages/rust/guide.md in its record, so stomme.toml cannot use it; run stomme sync',
    ),
  },
  {
    name: 'rejects a record without a selected layer guide',
    pin: { ...rustPin, layers: ['herdr'] },
    synced: synced('0.2.0', allGuides),
    expected: broken(
      'docs/stomme has no layers/herdr/guide.md in its record, so stomme.toml cannot use it; run stomme sync',
    ),
  },
];

const bundleTable: { name: string; bundle: SyncedGuides; expected: GuideSelection }[] = [
  {
    name: 'selects the bundle',
    bundle: synced('0.2.0', allGuides),
    expected: {
      kind: 'bundle',
      root: bundleRoot,
      version: '0.2.0',
      guides: [guide('shared/coding.md')],
      languageGuides: {
        rust: guide('languages/rust/guide.md'),
        typescript: guide('languages/typescript/guide.md'),
      },
    },
  },
  {
    name: 'rejects a broken bundle',
    bundle: { kind: 'broken', reason: '/tau/vendor/stomme is damaged' },
    expected: brokenAtBundle('/tau/vendor/stomme is damaged'),
  },
  {
    name: 'rejects a bundle without a language guide',
    bundle: synced('0.2.0', without('languages/rust/guide.md')),
    expected: brokenAtBundle(
      'The bundle has no languages/rust/guide.md in its record; regenerate it',
    ),
  },
  {
    name: 'rejects a bundle without the general guide',
    bundle: synced('0.2.0', without('shared/coding.md')),
    expected: brokenAtBundle('The bundle has no shared/coding.md in its record; regenerate it'),
  },
  {
    name: 'rejects a bundle without the TypeScript guide',
    bundle: synced('0.2.0', without('languages/typescript/guide.md')),
    expected: brokenAtBundle(
      'The bundle has no languages/typescript/guide.md in its record; regenerate it',
    ),
  },
];

it('plans the guide reads from the configuration', () => {
  for (const row of planTable) {
    expect(planGuides(row.config), row.name).toEqual(row.expected);
  }
});

it('selects the guides of a project', () => {
  for (const row of projectTable) {
    expect(selectProjectGuides(root, row.pin, row.synced), row.name).toEqual(row.expected);
  }
});

it('selects the guides of the bundle', () => {
  for (const row of bundleTable) {
    expect(selectBundleGuides(bundleRoot, row.bundle), row.name).toEqual(row.expected);
  }
});
