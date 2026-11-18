import { expect, it } from 'vitest';

import type { SyncedGuides } from '../syncedGuides.js';
import { decideGuides } from './stommeGuidesDecision.js';
import type { ConfigFact, GuideSelection } from './stommeGuidesDecision.js';

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

const broken = (reason: string): GuideSelection => ({ kind: 'broken', root, reason });

const missingConfig: ConfigFact = { kind: 'missing', bundleRoot };

const table: {
  name: string;
  config: ConfigFact;
  synced?: SyncedGuides;
  bundle?: SyncedGuides;
  expected: GuideSelection;
}[] = [
  {
    name: 'selects a Rust project with the gpui layer',
    config: rustConfig('layers = ["gpui"]'),
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
    config: config('schema = 1', 'version = "0.2.0"', 'language = "typescript"'),
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
    name: 'orders layers by name',
    config: rustConfig('layers = ["react", "gpui"]'),
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
    name: 'ignores keys it does not read',
    config: rustConfig('profile = 7', '[checks]', 'strict = true'),
    synced: synced('0.2.0', allGuides),
    expected: {
      kind: 'project',
      root,
      version: '0.2.0',
      language: 'rust',
      layers: [],
      guides: [guide('shared/coding.md'), guide('languages/rust/guide.md')],
    },
  },
  {
    name: 'uses the bundle without stomme.toml',
    config: missingConfig,
    bundle: synced('0.2.0', allGuides),
    expected: {
      kind: 'bundle',
      version: '0.2.0',
      guides: [guide('shared/coding.md')],
      languageGuides: {
        rust: guide('languages/rust/guide.md'),
        typescript: guide('languages/typescript/guide.md'),
      },
    },
  },
  {
    name: 'rejects an unreadable configuration',
    config: { kind: 'unreadable', root, error: 'EACCES: permission denied' },
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml cannot be read: EACCES: permission denied'),
  },
  {
    name: 'rejects a missing schema',
    config: config('version = "0.2.0"', 'language = "rust"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `schema = 1`'),
  },
  {
    name: 'rejects another schema',
    config: config('schema = 2', 'version = "0.2.0"', 'language = "rust"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `schema = 1`'),
  },
  {
    name: 'rejects a schema that is not an integer',
    config: config('schema = "1"', 'version = "0.2.0"', 'language = "rust"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `schema = 1`'),
  },
  {
    name: 'rejects a missing version',
    config: config('schema = 1', 'language = "rust"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs a `version` string, such as `version = "0.2.0"`'),
  },
  {
    name: 'rejects an empty version',
    config: config('schema = 1', 'version = ""', 'language = "rust"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs a `version` string, such as `version = "0.2.0"`'),
  },
  {
    name: 'rejects a version that is not a string',
    config: config('schema = 1', 'version = 2', 'language = "rust"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs a `version` string, such as `version = "0.2.0"`'),
  },
  {
    name: 'rejects a missing language',
    config: config('schema = 1', 'version = "0.2.0"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `language = "rust"` or `language = "typescript"`'),
  },
  {
    name: 'rejects another language',
    config: config('schema = 1', 'version = "0.2.0"', 'language = "python"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `language = "rust"` or `language = "typescript"`'),
  },
  {
    name: 'rejects layers that are not an array',
    config: rustConfig('layers = "gpui"'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `layers` to be an array of strings'),
  },
  {
    name: 'rejects a layer that is not a string',
    config: rustConfig('layers = ["gpui", 3]'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml needs `layers` to be an array of strings'),
  },
  {
    name: 'rejects duplicate layers',
    config: rustConfig('layers = ["gpui", "react", "gpui"]'),
    synced: synced('0.2.0', allGuides),
    expected: broken('/project/stomme.toml lists the layer `gpui` more than once'),
  },
  {
    name: 'rejects invalid TOML',
    config: config('schema = ='),
    synced: synced('0.2.0', allGuides),
    expected: {
      kind: 'broken',
      root,
      reason: expect.stringMatching(/^\/project\/stomme\.toml is not valid TOML: \S/) as string,
    },
  },
  {
    name: 'passes a broken synced folder through',
    config: rustConfig(),
    synced: { kind: 'broken', reason: '/project/docs/stomme is damaged' },
    expected: broken('/project/docs/stomme is damaged'),
  },
  {
    name: 'rejects synced guides of another version',
    config: rustConfig(),
    synced: synced('0.1.0', allGuides),
    expected: broken('docs/stomme holds stomme 0.1.0, but stomme.toml pins 0.2.0; run stomme sync'),
  },
  {
    name: 'rejects a record without the general guide',
    config: rustConfig(),
    synced: synced('0.2.0', without('shared/coding.md')),
    expected: broken(
      'docs/stomme has no shared/coding.md in its record, so stomme.toml cannot use it; run stomme sync',
    ),
  },
  {
    name: 'rejects a record without the language guide',
    config: rustConfig(),
    synced: synced('0.2.0', without('languages/rust/guide.md')),
    expected: broken(
      'docs/stomme has no languages/rust/guide.md in its record, so stomme.toml cannot use it; run stomme sync',
    ),
  },
  {
    name: 'rejects a record without a selected layer guide',
    config: rustConfig('layers = ["herdr"]'),
    synced: synced('0.2.0', allGuides),
    expected: broken(
      'docs/stomme has no layers/herdr/guide.md in its record, so stomme.toml cannot use it; run stomme sync',
    ),
  },
  {
    name: 'rejects a broken bundle',
    config: missingConfig,
    bundle: { kind: 'broken', reason: '/tau/vendor/stomme is damaged' },
    expected: { kind: 'broken', root: bundleRoot, reason: '/tau/vendor/stomme is damaged' },
  },
  {
    name: 'rejects a bundle without a language guide',
    config: missingConfig,
    bundle: synced('0.2.0', without('languages/rust/guide.md')),
    expected: {
      kind: 'broken',
      root: bundleRoot,
      reason: 'The bundle has no languages/rust/guide.md in its record; regenerate it',
    },
  },
  {
    name: 'rejects a project whose guides were not read',
    config: rustConfig(),
    expected: broken('The guides of /project were not read'),
  },
  {
    name: 'rejects a bundle that was not read',
    config: missingConfig,
    expected: { kind: 'broken', root: bundleRoot, reason: 'The bundle was not read' },
  },
];

it('decides the guide selection', () => {
  for (const row of table) {
    expect(decideGuides(row.config, row.synced, row.bundle), row.name).toEqual(row.expected);
  }
});
