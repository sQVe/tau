import { join } from 'node:path';

import { expect, it } from 'vitest';

import { documentProblems, findDocumentProblems } from './markdownFiles.js';
import type { Document, DocumentProblemKind } from './markdownFiles.js';

const repositoryRoot = join(import.meta.dirname, '..');

// Backticked paths that name no file in this repository on purpose: paths in projects that use
// Pi, herdr source files, and the former root layout that ADRs 0001 and 0004 describe. Remove an
// entry when no document names it.
const allowedPaths = [
  '.pi/agents/',
  '.pi/settings.json',
  'extensions/',
  'skills/',
  'src/agent_resume.rs',
  'src/app/agent_resume.rs',
  'src/persist/restore.rs',
];

const root = '/repository';
const firstAdr = { file: 'docs/adr/0001-first.md', markdown: '# ADR 0001: First\n' };
const firstEntry = '- [0001: First](./0001-first.md)';

const indexOf = (...entries: string[]) => ({
  file: 'docs/adr/README.md',
  markdown: `# ADRs\n\n## Index\n\n${entries.join('\n')}\n`,
});

const guide = (markdown: string) => ({ file: 'docs/guide.md', markdown });
const sourceFiles = ['src/tau.ts', 'src/extensions/coding.ts'];

const problemsIn = (documents: readonly Document[], allowed: readonly string[] = []) =>
  documentProblems(
    root,
    documents,
    [...documents.map((document) => document.file), ...sourceFiles],
    allowed,
  ).map(({ file, kind }) => ({ file, kind }));

it('finds no problems in the tracked documents', () => {
  expect(findDocumentProblems(repositoryRoot, allowedPaths)).toEqual([]);
});

it.each<[string, Document[], DocumentProblemKind, string]>([
  ['a broken link', [guide('Read [the plan](plan.md).\n')], 'broken-link', 'docs/guide.md'],
  [
    'a link to a missing heading in another file',
    [guide('Read [the index](adr/README.md#history).\n')],
    'missing-heading',
    'docs/guide.md',
  ],
  [
    'a link to a missing heading in the same file',
    [guide('# Guide\n\nJump to [setup](#setup).\n')],
    'missing-heading',
    'docs/guide.md',
  ],
  [
    'a missing backticked path',
    [guide('Edit `src/extensions/index.ts`.\n')],
    'missing-path',
    'docs/guide.md',
  ],
  [
    'a backticked path under a former root',
    [guide('Read `skills/commit/SKILL.md`.\n')],
    'missing-path',
    'docs/guide.md',
  ],
  [
    'a missing backticked directory',
    [guide('Read `src/models/`.\n')],
    'missing-path',
    'docs/guide.md',
  ],
  [
    'an ADR missing from the index',
    [{ file: 'docs/adr/0002-second.md', markdown: '# ADR 0002: Second\n' }],
    'adr-index',
    'docs/adr/README.md',
  ],
])('reports %s', (_case, extraDocuments, kind, file) => {
  const problems = problemsIn([indexOf(firstEntry), firstAdr, ...extraDocuments]);

  expect(problems).toEqual([{ file, kind }]);
});

it.each<[string, string[], Document]>([
  ['an ADR listed twice', [firstEntry, firstEntry], firstAdr],
  ['an ADR listed with another title', ['- [0001: Old](./0001-first.md)'], firstAdr],
  [
    'an index entry for a file that is not an ADR',
    [firstEntry, '- [0002: Gone](./0002-gone.md)'],
    firstAdr,
  ],
  [
    'an ADR whose heading has another number',
    [firstEntry],
    { file: firstAdr.file, markdown: '# ADR 0009: First\n' },
  ],
  ['an ADR without an ADR heading', [firstEntry], { file: firstAdr.file, markdown: '# First\n' }],
])('reports %s in the ADR index', (_case, entries, adr) => {
  const problems = problemsIn([indexOf(...entries), adr]).filter(
    (problem) => problem.kind === 'adr-index',
  );

  expect(problems).toEqual([{ file: 'docs/adr/README.md', kind: 'adr-index' }]);
});

it('reports an allowed path that no document names as missing', () => {
  const documents = [indexOf(firstEntry), firstAdr, guide('Edit `src/tau.ts`.\n')];

  expect(problemsIn(documents, ['src/gone.ts', 'src/tau.ts'])).toEqual([
    { file: 'tests/markdownFiles.test.ts', kind: 'stale-allowlist' },
    { file: 'tests/markdownFiles.test.ts', kind: 'stale-allowlist' },
  ]);
});

it('accepts valid links, headings, paths, and code spans that are not paths', () => {
  const body = [
    '# Guide',
    '',
    '## Run `pnpm check` first',
    '',
    '## Notes',
    '',
    '## Notes',
    '',
    '## Notes-1',
    '',
    '## [Linked](../README.md) heading, with punctuation!',
    '',
    'Setext title',
    '============',
    '',
    'Setext section',
    '--------------',
    '',
    'Jump to [checks](#run-pnpm-check-first), [notes](#notes-1-1), and [link](#linked-heading-with-punctuation).',
    'Jump to [the title](#setext-title) and [the section](#setext-section).',
    'Read [ADR 0001](adr/0001-first.md#adr-0001-first) and [the index][index].',
    'Open [the source](../src/tau.ts#L1), [the folder](../src/extensions/), and [the site](https://example.com/x.md#y).',
    '',
    '[index]: adr/README.md#index',
    '',
    'Edit `src/tau.ts`, `./src/extensions/coding.ts`, and `src/extensions/`.',
    'Run `pnpm test src/gone.test.ts`, match `src/**/*.ts`, or fill `src/<name>/index.ts`.',
    'Read `~/.pi/agent/tau.json`, `$dir/report.md`, `bulkRead/index.ts`, and `origin/main`.',
    'Allow `src/example.rs`.',
    '',
    '```markdown',
    '[fenced](missing.md) and `src/fenced.ts`',
    '```',
    '',
  ].join('\n');

  const documents = [
    indexOf(firstEntry),
    firstAdr,
    guide(body),
    { file: 'README.md', markdown: '# Tau\n' },
    { file: 'CHANGELOG.md', markdown: '- Removed `src/extensions/index.ts`.\n' },
  ];

  expect(problemsIn(documents, ['src/example.rs'])).toEqual([]);
});
