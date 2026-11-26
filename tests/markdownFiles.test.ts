import { join } from 'node:path';

import { expect, it } from 'vitest';

import { documentProblems, findDocumentProblems } from './markdownFiles.js';
import type { AllowedPaths, Document, DocumentProblemKind } from './markdownFiles.js';

const repositoryRoot = join(import.meta.dirname, '..');

// Backticked paths that name no file in this repository on purpose, with the documents that may
// name them: paths in projects that use Pi, herdr source files, and the layout that older records
// describe. Remove a document when it stops naming the path.
const allowedPaths: AllowedPaths = {
  '.pi/settings.json': [
    'docs/adr/0061-layer-tau-config-from-user-and-repository-files.md',
    'docs/development.md',
  ],
  'skills/': ['docs/adr/0003-externally-observable-identifiers.md'],
  'src/extensions/draftReview/herdrReview.ts': ['scripts/mutation-tuning.md'],
};

const root = '/repository';

const adrOf = (number: string, title: string, status: string, ...fields: string[]) => ({
  file: `docs/adr/${number}-${title.toLowerCase()}.md`,
  markdown: `# ADR ${number}: ${title}\n\n${['**Date**: 2026-01-01', `**Status**: ${status}`, ...fields].join('\\\n')}\n`,
});

const firstAdr = adrOf('0001', 'First', 'Accepted');

const firstEntry = '- [0001: First](./0001-first.md)';

const indexOf = (...entries: string[]) => ({
  file: 'docs/adr/README.md',
  markdown: `# ADRs\n\n## Index\n\n${entries.join('\n')}\n`,
});

const guide = (markdown: string) => ({ file: 'docs/guide.md', markdown });
const sourceFiles = ['src/tau.ts', 'src/extensions/coding.ts'];

const problemsIn = (documents: readonly Document[], allowed: AllowedPaths = {}) =>
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
    'a broken link after an escaped comment opener',
    [guide('\\<!-- text\n\n[the plan](plan.md)\n\n<!-- note -->\n')],
    'broken-link',
    'docs/guide.md',
  ],
  [
    'a broken link after a comment that closes inside a code span',
    [guide('<!-- note: `-->`\n\n[the plan](plan.md)\n\n<!-- later -->\n')],
    'broken-link',
    'docs/guide.md',
  ],
  [
    'a broken link after a link title that looks like a comment opener',
    [guide('[the index](adr/README.md "<!--") and [the plan](plan.md)\n\n<!-- note -->\n')],
    'broken-link',
    'docs/guide.md',
  ],
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
])('reports %s', (_case, extraDocuments, kind, file) => {
  const problems = problemsIn([indexOf(firstEntry), firstAdr, ...extraDocuments]);

  expect(problems).toEqual([{ file, kind }]);
});

it('skips backticked paths in a synced stomme document', () => {
  const synced = {
    file: 'docs/stomme/shared/coding.md',
    markdown: 'Keep each module in `src/core` and `src/store` of another project.\n',
  };

  expect(problemsIn([synced])).toEqual([]);
});

it('reports a broken link in a synced stomme document', () => {
  const synced = {
    file: 'docs/stomme/shared/coding.md',
    markdown: 'Read [the guide](guide.md).\n',
  };

  expect(problemsIn([synced])).toEqual([
    { file: 'docs/stomme/shared/coding.md', kind: 'broken-link' },
  ]);
});

it('reports an allowed path that its document does not name as missing', () => {
  const documents = [indexOf(firstEntry), firstAdr, guide('Edit `src/tau.ts`.\n')];

  expect(
    problemsIn(documents, { 'src/gone.ts': ['docs/guide.md'], 'src/tau.ts': ['docs/guide.md'] }),
  ).toEqual([
    { file: 'tests/markdownFiles.test.ts', kind: 'stale-allowlist' },
    { file: 'tests/markdownFiles.test.ts', kind: 'stale-allowlist' },
  ]);
});

it('reports a path allowed for one document in another document', () => {
  const adr = { ...firstAdr, markdown: `${firstAdr.markdown}\nAdd \`src/gone/\`.\n` };
  const documents = [indexOf(firstEntry), adr, guide('Read `src/gone/`.\n')];

  expect(problemsIn(documents, { 'src/gone/': [firstAdr.file] })).toEqual([
    { file: 'docs/guide.md', kind: 'missing-path' },
  ]);
});

it('accepts valid links, headings, paths, and code spans that are not paths', () => {
  const body = [
    '# Guide',
    '',
    '## Run `pnpm check` first',
    '',
    '## Run `[link](./x.md)` now',
    '',
    '## Notes',
    '',
    '## Notes',
    '',
    '## Notes-1',
    '',
    '## [Linked](../README.md) heading, with punctuation!',
    '',
    '[Linked](../README.md) Setext',
    '----------------------------',
    '',
    'Setext title',
    '============',
    '',
    'Setext section',
    '--------------',
    '',
    '# Intro',
    'Setext after a heading',
    '----------------------',
    '',
    'Jump to [checks](#run-pnpm-check-first), [notes](#notes-1-1), and [link](#linked-heading-with-punctuation).',
    'Jump to [the run](#run-linkxmd-now) and [linked setext](#linked-setext).',
    'Jump to [the title](#setext-title), [the section](#setext-section), and [the next](#setext-after-a-heading).',
    'Open [the repository](../) and [its root](..).',
    'Read [the plain index](adr/README.md?plain=1#index).',
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
    '<!-- Link the record: [ADR NNNN](./NNNN-file-name.md)',
    'or [the plan](plan.md). -->',
    '',
    '```markdown',
    '[fenced](missing.md) and `src/fenced.ts`',
    '```',
    '',
    '<!-- An unclosed comment runs to the end: [draft](draft.md)',
    '',
  ].join('\n');

  const documents = [
    indexOf(firstEntry),
    firstAdr,
    guide(body),
    { file: 'README.md', markdown: '# Tau\n' },
    { file: 'CHANGELOG.md', markdown: '- Removed `src/extensions/index.ts`.\n' },
  ];

  expect(problemsIn(documents, { 'src/example.rs': ['docs/guide.md'] })).toEqual([]);
});
