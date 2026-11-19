import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import type { GuideLanguage } from '../stommeGuides/stommeGuidesDecision.js';
import {
  classifyLanguageActivation,
  commandOutcome,
  languageForPath,
  languageRulesTypes,
  languageToolDecision,
} from './languageRulesDecision.js';

type Decision = ReturnType<typeof languageToolDecision>;

const activate = (language: GuideLanguage): Decision => ({
  kind: 'activate',
  language,
});

const block = (language: GuideLanguage): Decision => ({
  kind: 'block',
  language,
});

const ignore: Decision = { kind: 'ignore' };
const none: ReadonlySet<GuideLanguage> = new Set();

const loadedTypeScript: ReadonlySet<GuideLanguage> = new Set<GuideLanguage>(['typescript']);

const loadedRust: ReadonlySet<GuideLanguage> = new Set<GuideLanguage>(['rust']);

it.for([
  {
    tool: 'read',
    path: 'src/main.ts',
    loaded: none,
    expected: activate('typescript'),
  },
  {
    tool: 'read',
    path: 'view.tsx',
    loaded: none,
    expected: activate('typescript'),
  },
  {
    tool: 'read',
    path: 'module.mts',
    loaded: none,
    expected: activate('typescript'),
  },
  {
    tool: 'read',
    path: 'module.cts',
    loaded: none,
    expected: activate('typescript'),
  },
  {
    tool: 'write',
    path: 'main.ts',
    loaded: none,
    expected: block('typescript'),
  },
  {
    tool: 'edit',
    path: 'main.ts',
    loaded: none,
    expected: block('typescript'),
  },
  {
    tool: 'write',
    path: 'main.ts',
    loaded: loadedTypeScript,
    expected: activate('typescript'),
  },
  {
    tool: 'edit',
    path: 'main.ts',
    loaded: loadedTypeScript,
    expected: activate('typescript'),
  },
  {
    tool: 'read',
    path: 'main.ts',
    loaded: loadedTypeScript,
    expected: activate('typescript'),
  },
  {
    tool: 'read',
    path: 'node_modules/package/main.ts',
    loaded: none,
    expected: ignore,
  },
  {
    tool: 'read',
    path: '/repo/node_modules/main.ts',
    loaded: none,
    expected: ignore,
  },
  {
    tool: 'read',
    path: 'C:\\repo\\node_modules\\main.ts',
    loaded: none,
    expected: ignore,
  },
  {
    tool: 'read',
    path: 'node_modules-extra/main.ts',
    loaded: none,
    expected: activate('typescript'),
  },
  { tool: 'read', path: 'main.d.ts', loaded: none, expected: ignore },
  { tool: 'read', path: 'main.d.mts', loaded: none, expected: ignore },
  { tool: 'read', path: 'main.d.cts', loaded: none, expected: ignore },
  {
    tool: 'read',
    path: 'main.d.ts.source.ts',
    loaded: none,
    expected: activate('typescript'),
  },
  { tool: 'read', path: 'main.js', loaded: none, expected: ignore },
  { tool: 'read', path: 'ts', loaded: none, expected: ignore },
  { tool: 'read', path: 'main.ts.txt', loaded: none, expected: ignore },
  { tool: 'bash', path: 'main.ts', loaded: none, expected: ignore },
  {
    tool: 'read',
    path: 'src/lib.rs',
    loaded: none,
    expected: activate('rust'),
  },
  { tool: 'write', path: 'src/lib.rs', loaded: none, expected: block('rust') },
  { tool: 'edit', path: 'src/lib.rs', loaded: none, expected: block('rust') },
  {
    tool: 'write',
    path: 'src/lib.rs',
    loaded: loadedRust,
    expected: activate('rust'),
  },
  {
    tool: 'edit',
    path: 'src/lib.rs',
    loaded: loadedRust,
    expected: activate('rust'),
  },
  {
    tool: 'read',
    path: 'src/lib.rs',
    loaded: loadedRust,
    expected: activate('rust'),
  },
  {
    tool: 'write',
    path: 'src/lib.rs',
    loaded: loadedTypeScript,
    expected: block('rust'),
  },
  {
    tool: 'write',
    path: 'main.ts',
    loaded: loadedRust,
    expected: block('typescript'),
  },
  {
    tool: 'read',
    path: 'target/debug/build/out.rs',
    loaded: none,
    expected: ignore,
  },
  {
    tool: 'read',
    path: '/repo/target/generated.rs',
    loaded: none,
    expected: ignore,
  },
  {
    tool: 'read',
    path: 'C:\\repo\\target\\generated.rs',
    loaded: none,
    expected: ignore,
  },
  {
    tool: 'read',
    path: 'target-extra/lib.rs',
    loaded: none,
    expected: activate('rust'),
  },
  {
    tool: 'read',
    path: 'src/target.rs',
    loaded: none,
    expected: activate('rust'),
  },
  {
    tool: 'read',
    path: 'node_modules/crate/lib.rs',
    loaded: none,
    expected: activate('rust'),
  },
  {
    tool: 'read',
    path: 'target/main.ts',
    loaded: none,
    expected: activate('typescript'),
  },
  { tool: 'write', path: 'target/../src/lib.rs', loaded: none, expected: block('rust') },
  { tool: 'read', path: 'target/../src/lib.rs', loaded: none, expected: activate('rust') },
  { tool: 'write', path: 'target\\..\\src\\lib.rs', loaded: none, expected: block('rust') },
  { tool: 'read', path: 'target//../src/lib.rs', loaded: none, expected: activate('rust') },
  { tool: 'read', path: './target/./../src/lib.rs', loaded: none, expected: activate('rust') },
  { tool: 'read', path: 'src/../target/debug/x.rs', loaded: none, expected: ignore },
  { tool: 'read', path: '../target/x.rs', loaded: none, expected: ignore },
  {
    tool: 'write',
    path: 'node_modules/../src/a.ts',
    loaded: none,
    expected: block('typescript'),
  },
  {
    tool: 'read',
    path: 'node_modules/../src/a.ts',
    loaded: none,
    expected: activate('typescript'),
  },
  { tool: 'read', path: 'src/../node_modules/pkg/a.ts', loaded: none, expected: ignore },
  { tool: 'write', path: 'src/lib.rs/.', loaded: none, expected: block('rust') },
  { tool: 'read', path: 'src/main.ts/.', loaded: none, expected: activate('typescript') },
  { tool: 'read', path: 'src/types.d.ts/.', loaded: none, expected: ignore },
  { tool: 'read', path: 'lib.rs.txt', loaded: none, expected: ignore },
  { tool: 'read', path: 'rs', loaded: none, expected: ignore },
  { tool: 'bash', path: 'src/lib.rs', loaded: none, expected: ignore },
  { tool: 'read', path: 'asset.constructor', loaded: none, expected: ignore },
  { tool: 'write', path: 'asset.constructor', loaded: none, expected: ignore },
  { tool: 'read', path: 'asset.toString', loaded: none, expected: ignore },
  {
    tool: 'read',
    path: 'asset.hasOwnProperty',
    loaded: none,
    expected: ignore,
  },
  { tool: 'read', path: 'asset.__proto__', loaded: none, expected: ignore },
  { tool: 'read', path: undefined, loaded: none, expected: ignore },
  { tool: 'read', path: 42, loaded: none, expected: ignore },
])(
  'decides language rule activation per tool and path: $tool $path',
  ({ tool, path, loaded, expected }) => {
    expect(languageToolDecision(tool, path, loaded)).toEqual(expected);
  },
);

it.for([
  { path: 'main.ts', expected: 'typescript' },
  { path: 'lib.rs', expected: 'rust' },
  { path: 'target/lib.rs', expected: undefined },
  { path: 'main.d.ts', expected: undefined },
  { path: 'README.md', expected: undefined },
  { path: 'asset.constructor', expected: undefined },
  { path: 'asset.valueOf', expected: undefined },
  { path: 7, expected: undefined },
])('finds the language of $path', ({ path, expected }) => {
  expect(languageForPath(path)).toBe(expected);
});

it('ignores a path that is not a string, even when it prints like a file name', () => {
  expect(languageForPath(['main.ts'])).toBeUndefined();
  expect(languageToolDecision('read', ['main.ts'], none)).toEqual(ignore);
});

const languages: readonly GuideLanguage[] = ['typescript', 'rust'];

const activationFixture = (language: GuideLanguage, name: string): unknown => {
  const path = new URL(`../fixtures/${language}Activation/${name}.json`, import.meta.url);

  return JSON.parse(readFileSync(path, 'utf8'));
};

const activationEntry = (language: GuideLanguage, data: unknown) => ({
  type: 'custom',
  customType: languageRulesTypes[language],
  data,
});

const unreadableCases = (language: GuideLanguage) => {
  const entry = (data: unknown) => [activationEntry(language, data)];
  const malformed = { active: false, unreadable: [{ kind: 'malformed' }] };

  return [
    { name: 'missing', entries: [], active: false, unreadable: [] },
    { name: 'null entry', entries: [null], active: false, unreadable: [] },
    {
      name: 'primitive entry',
      entries: ['activation'],
      active: false,
      unreadable: [],
    },
    { name: 'primitive data', entries: entry('activation'), ...malformed },
    {
      name: 'current after malformed and newer entries',
      entries: [
        activationFixture(language, 'malformed'),
        activationFixture(language, 'newer'),
        activationFixture(language, 'current'),
      ],
      active: true,
      unreadable: [{ kind: 'malformed' }, { kind: 'newer', version: 2 }],
    },
    {
      name: 'current before unreadable entries',
      entries: [
        activationFixture(language, 'current'),
        activationFixture(language, 'newer'),
        activationFixture(language, 'malformed'),
      ],
      active: true,
      unreadable: [{ kind: 'newer', version: 2 }, { kind: 'malformed' }],
    },
    {
      name: 'current',
      entries: [activationFixture(language, 'current')],
      active: true,
      unreadable: [],
    },
    {
      name: 'newer',
      entries: [activationFixture(language, 'newer')],
      active: false,
      unreadable: [{ kind: 'newer', version: 2 }],
    },
    {
      name: 'newer schema',
      entries: entry({ version: 3, extra: true }),
      active: false,
      unreadable: [{ kind: 'newer', version: 3 }],
    },
    {
      name: 'malformed',
      entries: [activationFixture(language, 'malformed')],
      ...malformed,
    },
    {
      name: 'missing data',
      entries: [{ type: 'custom', customType: languageRulesTypes[language] }],
      ...malformed,
    },
    { name: 'null data', entries: entry(null), ...malformed },
    { name: 'missing version', entries: entry({}), ...malformed },
    {
      name: 'noninteger version',
      entries: entry({ version: 2.5 }),
      ...malformed,
    },
    {
      name: 'infinite version',
      entries: entry({ version: Infinity }),
      ...malformed,
    },
    { name: 'zero version', entries: entry({ version: 0 }), ...malformed },
    {
      name: 'extra fields',
      entries: entry({ version: 1, extra: true }),
      ...malformed,
    },
    {
      name: 'other entry',
      entries: [{ type: 'custom', customType: 'other', data: { version: 1 } }],
      active: false,
      unreadable: [],
    },
    {
      name: 'message',
      entries: [
        {
          type: 'message',
          customType: languageRulesTypes[language],
          data: { version: 1 },
        },
      ],
      active: false,
      unreadable: [],
    },
  ];
};

for (const language of languages) {
  it.for(unreadableCases(language))(
    `rebuilds ${language} activation from $name evidence`,
    ({ entries, active, unreadable }) => {
      expect(classifyLanguageActivation(entries, language)).toEqual({
        active,
        unreadable,
      });
    },
  );
}

it('keeps activation entries of the other language apart', () => {
  const entries = [activationFixture('rust', 'current')];

  expect(classifyLanguageActivation(entries, 'typescript')).toEqual({
    active: false,
    unreadable: [],
  });
});

const bundle = { kind: 'bundle', root: '/bundle' } as const;

const notice = (reason: 'broken' | 'no-coding-set' | 'loaded', level: 'info' | 'warning') => ({
  kind: 'notice',
  reason,
  level,
});

const otherLanguage = (declared: GuideLanguage) => ({
  kind: 'notice',
  reason: 'other-language',
  level: 'warning',
  declared,
});

it.for([
  {
    snapshot: bundle,
    requested: 'rust',
    coding: true,
    expected: { kind: 'activate', bundle },
  },
  {
    snapshot: bundle,
    requested: 'typescript',
    coding: false,
    expected: { kind: 'activate', bundle },
  },
  {
    snapshot: { kind: 'broken' },
    requested: 'rust',
    coding: true,
    expected: notice('broken', 'warning'),
  },
  {
    snapshot: { kind: 'broken' },
    requested: 'rust',
    coding: false,
    expected: notice('broken', 'warning'),
  },
  {
    snapshot: { kind: 'project', language: 'rust' },
    requested: 'rust',
    coding: true,
    expected: notice('loaded', 'info'),
  },
  {
    snapshot: { kind: 'project', language: 'typescript' },
    requested: 'typescript',
    coding: true,
    expected: notice('loaded', 'info'),
  },
  {
    snapshot: { kind: 'project', language: 'rust' },
    requested: 'typescript',
    coding: true,
    expected: otherLanguage('rust'),
  },
  {
    snapshot: { kind: 'project', language: 'typescript' },
    requested: 'rust',
    coding: true,
    expected: otherLanguage('typescript'),
  },
  {
    snapshot: { kind: 'project', language: 'rust' },
    requested: 'rust',
    coding: false,
    expected: notice('no-coding-set', 'warning'),
  },
  {
    snapshot: { kind: 'project', language: 'rust' },
    requested: 'typescript',
    coding: false,
    expected: notice('no-coding-set', 'warning'),
  },
] as const)(
  'decides the command outcome in $snapshot.kind mode for $requested with coding set $coding',
  ({ snapshot, requested, coding, expected }) => {
    expect(commandOutcome<typeof bundle>(snapshot, requested, coding)).toEqual(expected);
  },
);
