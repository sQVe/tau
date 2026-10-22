import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { pinnedTargetSchema, reviewTargetSchema } from './target.js';

const sha = 'a'.repeat(40);

const requestedTargets = {
  workingTree: { kind: 'workingTree', base: 'HEAD', exclude: ['generated.txt'] },
  range: { kind: 'range', from: 'main', to: 'HEAD', exclude: ['generated.txt'] },
  rootCommit: { kind: 'rootCommit', commit: 'HEAD', exclude: ['generated.txt'] },
  files: { kind: 'files', paths: ['src/a.ts'], base: 'HEAD', exclude: ['generated.txt'] },
  fix: {
    kind: 'fix',
    review: '.tau/workers/review-abc',
    findingPaths: ['src/a.ts'],
    exclude: ['generated.txt'],
  },
};

const pinnedTargets = {
  workingTree: { kind: 'workingTree', base: sha, exclude: ['generated.txt'] },
  range: { kind: 'range', from: sha, to: sha, exclude: ['generated.txt'] },
  rootCommit: { kind: 'rootCommit', commit: sha, exclude: ['generated.txt'] },
  files: { kind: 'files', paths: ['src/a.ts'], base: sha, exclude: ['generated.txt'] },
  fix: {
    kind: 'fix',
    review: '.tau/workers/review-abc',
    findingPaths: ['src/a.ts'],
    base: sha,
    exclude: ['generated.txt'],
  },
};

const emptyFields = {
  workingTree: { base: '', exclude: [''] },
  range: { from: '', to: '', exclude: [''] },
  rootCommit: { commit: '', exclude: [''] },
  files: { paths: [], exclude: [''] },
  fix: { review: '', findingPaths: [''], exclude: [''] },
};

const kinds = ['workingTree', 'range', 'rootCommit', 'files', 'fix'] as const;

describe.each([
  ['requested', reviewTargetSchema, requestedTargets],
  ['pinned', pinnedTargetSchema, pinnedTargets],
] as const)('%s target schema', (_name, schema, targets) => {
  it.each(kinds)('accepts a %s target', (kind) => {
    expect(Value.Check(schema, targets[kind])).toBe(true);
  });

  it.each(kinds)('accepts a %s target without exclude', (kind) => {
    const { exclude: _exclude, ...target } = targets[kind];

    expect(Value.Check(schema, target)).toBe(true);
  });

  it.each(kinds)('refuses a %s target with an unknown field', (kind) => {
    expect(Value.Check(schema, { ...targets[kind], extra: 1 })).toBe(false);
  });

  it.each(kinds)('refuses a %s target with an empty string where a name belongs', (kind) => {
    for (const [field, value] of Object.entries(emptyFields[kind])) {
      expect(Value.Check(schema, { ...targets[kind], [field]: value }), field).toBe(false);
    }
  });

  it('refuses a files target with an empty path', () => {
    expect(Value.Check(schema, { ...targets.files, paths: [''] })).toBe(false);
  });

  it('refuses a target of an unknown kind', () => {
    expect(Value.Check(schema, { kind: 'stash' })).toBe(false);
  });
});

it('accepts a files target without a base', () => {
  const { base: _base, ...target } = requestedTargets.files;

  expect(Value.Check(reviewTargetSchema, target)).toBe(true);
});

it('refuses a pinned target whose revision is not a full object name', () => {
  expect(Value.Check(pinnedTargetSchema, { ...pinnedTargets.workingTree, base: 'HEAD' })).toBe(
    false,
  );
});

it('refuses a pinned fix target without a base field', () => {
  const { base: _base, ...target } = pinnedTargets.fix;

  expect(Value.Check(pinnedTargetSchema, target)).toBe(false);
});

it('accepts a pinned fix target with a null base', () => {
  expect(Value.Check(pinnedTargetSchema, { ...pinnedTargets.fix, base: null })).toBe(true);
});
