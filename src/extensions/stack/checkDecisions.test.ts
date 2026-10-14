import { expect, it } from 'vitest';

import type { Repository } from '../../github.js';
import {
  decideGithub,
  decideStackView,
  needsBasePull,
  readStacksResponse,
  selectHeadPull,
} from './checkDecisions.js';
import type {
  BasedPull,
  GithubFacts,
  HeadPull,
  StackLayer,
  StackView,
  StackViewRead,
} from './checkDecisions.js';
import { readFailed, readOk } from './readResult.js';
import type { CommandOutput } from './readResult.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const pushRepository: Repository = { host: 'github.com', owner: 'fork', name: 'tau' };
const baseRepository: Repository = { host: 'github.com', owner: 'sQVe', name: 'tau' };

const layer = (name: string, flags: Partial<StackLayer> = {}): StackLayer => ({
  name,
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  isCurrent: false,
  isMerged: false,
  isQueued: false,
  needsRebase: false,
  pr: { number: 1, url: 'https://github.com/sQVe/tau/pull/1', state: 'OPEN' },
  ...flags,
});

const stackView = (branches: StackLayer[]): StackView => ({
  trunk: 'main',
  currentBranch: 'middle',
  branches,
});

const viewRead = (exitCode: number | null, view: StackViewRead['view']): StackViewRead => ({
  exitCode,
  view,
});

const tracked = (branches: StackLayer[]) =>
  decideStackView('middle', {
    rebasePaused: false,
    stackView: viewRead(0, readOk(stackView(branches))),
  });

it('skips gh stack view for a branch that is not the current branch', () => {
  expect(decideStackView('other', null)).toEqual({ result: 'github' });
});

it.each([
  { branches: ['bottom', 'middle', 'top'], parent: 'bottom', layer: 'middle' },
  { branches: ['middle', 'top'], parent: 'main', layer: 'bottom of the stack' },
  { branches: ['bottom', 'top', 'middle'], parent: 'top', layer: 'top of the stack' },
])('names $parent as the parent of the $layer', ({ branches, parent }) => {
  const decision = tracked(branches.map((name) => layer(name)));

  expect(decision).toMatchObject({ result: 'tracked', trunk: 'main', parent });
});

it.each([
  {
    below: [layer('bottom', { isMerged: true })],
    parent: 'main',
    why: 'the only branch below is merged',
  },
  {
    below: [layer('bottom'), layer('lower', { isMerged: true })],
    parent: 'bottom',
    why: 'the nearest branch below is merged',
  },
  {
    below: [layer('bottom', { isMerged: true }), layer('lower', { isQueued: true })],
    parent: 'lower',
    why: 'the branch below is queued, not merged',
  },
])('names $parent as the parent when $why', ({ below, parent }) => {
  expect(tracked([...below, layer('middle'), layer('top')])).toMatchObject({
    result: 'tracked',
    parent,
  });
});

it('returns the layers of a tracked stack, bottom to top', () => {
  const decision = tracked([layer('bottom'), layer('middle')]);

  expect(decision).toMatchObject({ layers: [{ name: 'bottom' }, { name: 'middle' }] });
});

it('decides github when gh stack view exits with 2, which only means no stack in this worktree', () => {
  const decision = decideStackView('middle', { rebasePaused: false, stackView: viewRead(2, null) });

  expect(decision).toEqual({ result: 'github' });
});

it.each([
  { exitCode: 6, result: 'unknown', reason: 'several stacks' },
  { exitCode: 1, result: 'unknown', reason: 'exited with code 1' },
  { exitCode: 7, result: 'unknown', reason: 'exited with code 7' },
  { exitCode: null, result: 'unknown', reason: 'did not finish' },
])('decides $result when gh stack view exits with $exitCode', ({ exitCode, result, reason }) => {
  const decision = decideStackView('middle', {
    rebasePaused: false,
    stackView: viewRead(exitCode, null),
  });

  expect(decision).toMatchObject({ result, reason: containing(reason) });
});

it('decides unknown, without reading gh stack view, while a stack rebase is paused', () => {
  const decision = decideStackView('middle', { rebasePaused: true, stackView: null });

  expect(decision).toMatchObject({ result: 'unknown', reason: containing('paused') });
});

it('decides unknown while a stack rebase is paused even when gh stack view exited 0', () => {
  const decision = decideStackView('middle', {
    rebasePaused: true,
    stackView: viewRead(0, readOk(stackView([layer('middle')]))),
  });

  expect(decision.result).toBe('unknown');
});

it.each([
  { view: null, reason: 'printed no output' },
  {
    view: readFailed('gh stack view --json', 'printed output that cannot be read: '),
    reason: 'cannot be read',
  },
])('decides unknown when exit 0 gives no readable stack: $reason', ({ view, reason }) => {
  const decision = decideStackView('middle', { rebasePaused: false, stackView: viewRead(0, view) });

  expect(decision).toMatchObject({ result: 'unknown', reason: containing(reason) });
});

it('decides unknown when the stack does not list the branch', () => {
  expect(tracked([layer('bottom')])).toMatchObject({
    result: 'unknown',
    reason: containing('lists no branch middle'),
  });
});

const output = (stdout: string, exitCode: number | null = 0, stderr = ''): CommandOutput => ({
  exitCode,
  stdout,
  stderr,
});

const stacksOutput = (number: unknown, pullRequests: unknown) =>
  output(JSON.stringify({ number, pullRequests }));

it.each([
  { out: stacksOutput(null, []), kind: 'none' },
  { out: stacksOutput(40, [11, 12, 13]), kind: 'stack' },
  { out: output('', 1, 'gh: Not Found (HTTP 404)'), kind: 'off' },
])('reads the stacks API output as $kind', ({ out, kind }) => {
  expect(readStacksResponse('gh api', out)).toMatchObject({ ok: true, value: { kind } });
});

it('keeps the stack number and the pull request numbers of a stack in order', () => {
  expect(readStacksResponse('gh api', stacksOutput(40, [3, 1, 2]))).toEqual(
    readOk({ kind: 'stack', number: 40, pullRequests: [3, 1, 2] }),
  );
});

it.each([
  { out: output('', 0), why: 'empty output' },
  { out: output('[]'), why: 'a list' },
  { out: output('null'), why: 'null' },
  { out: output('{}'), why: 'an object without fields' },
  { out: stacksOutput(40, ['1']), why: 'string numbers' },
  { out: stacksOutput(40, [1.5]), why: 'a fraction' },
  { out: stacksOutput('forty', [1]), why: 'a stack number that is not a number' },
  { out: stacksOutput(null, [1]), why: 'pull requests without a stack number' },
  { out: output('{"number":1,'), why: 'cut off JSON' },
  { out: output('', 1, 'gh: Server Error (HTTP 500)'), why: 'an HTTP 500' },
  { out: output('', 4, 'authentication required'), why: 'no authentication' },
  { out: output('', null), why: 'a command that did not finish' },
])('fails the stacks API read for $why', ({ out }) => {
  expect(readStacksResponse('gh api', out)).toMatchObject({ ok: false, command: 'gh api' });
});

const headPull = (number: number, owner = 'fork', name: string | null = 'tau'): HeadPull => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  baseRefName: 'main',
  headRepositoryOwner: { login: owner },
  headRepository: name === null ? null : { name },
});

it.each([
  { listed: [], expected: { kind: 'none' } },
  { listed: [headPull(1, 'other')], expected: { kind: 'none' } },
  { listed: [headPull(1, 'fork', 'other')], expected: { kind: 'none' } },
  { listed: [headPull(1, 'fork', null)], expected: { kind: 'none' } },
  {
    listed: [headPull(1, 'FORK', 'TAU')],
    expected: { kind: 'one', pull: headPull(1, 'FORK', 'TAU') },
  },
  { listed: [headPull(1, 'other'), headPull(2)], expected: { kind: 'one', pull: headPull(2) } },
  { listed: [headPull(1), headPull(2)], expected: { kind: 'several', numbers: [1, 2] } },
])(
  'selects the head pull request from $listed.length listed: $expected.kind',
  ({ listed, expected }) => {
    expect(selectHeadPull(listed, pushRepository)).toEqual(expected);
  },
);

it.each([
  { baseRefName: 'main', needs: false },
  { baseRefName: 'feature', needs: true },
])(
  'reads the base pull request: $needs when the base is $baseRefName',
  ({ baseRefName, needs }) => {
    expect(needsBasePull({ ...headPull(1), baseRefName }, 'main')).toBe(needs);
  },
);

const basedOn = (number: number, headRefName: string): BasedPull => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headRefName,
});

const facts = (overrides: Partial<GithubFacts> = {}): GithubFacts => ({
  defaultBranch: 'main',
  pushRepository,
  baseRepository,
  headPulls: readOk([headPull(5)]),
  basedOn: readOk([]),
  stacks: readOk({ kind: 'none' }),
  basePulls: null,
  ...overrides,
});

it.each([
  { name: 'no pull request at all', facts: facts({ headPulls: readOk([]), stacks: null }) },
  { name: 'a pull request that nothing touches', facts: facts() },
  { name: 'stacked pull requests turned off', facts: facts({ stacks: readOk({ kind: 'off' }) }) },
  {
    name: 'a pull request on another fork',
    facts: facts({ headPulls: readOk([headPull(5, 'someone')]), stacks: null }),
  },
  {
    name: 'a base pull request from a fork of the base repository',
    facts: facts({
      headPulls: readOk([{ ...headPull(5), baseRefName: 'feature' }]),
      basePulls: readOk([headPull(4, 'someone')]),
    }),
  },
  {
    name: 'a base pull request that is gone',
    facts: facts({
      headPulls: readOk([{ ...headPull(5), baseRefName: 'feature' }]),
      basePulls: readOk([]),
    }),
  },
])('decides standalone for $name', ({ facts: given }) => {
  expect(decideGithub('feature', given)).toEqual({ result: 'standalone' });
});

it('decides untracked when a GitHub stack holds the pull request', () => {
  const decision = decideGithub(
    'feature',
    facts({ stacks: readOk({ kind: 'stack', number: 40, pullRequests: [4, 5, 6] }) }),
  );

  expect(decision).toMatchObject({
    result: 'untracked',
    held: ['githubStack'],
    githubStack: { number: 40, pullRequests: [4, 5, 6] },
  });
});

it('decides untracked when the base has an open pull request, and lists the chain', () => {
  const decision = decideGithub(
    'feature',
    facts({
      headPulls: readOk([{ ...headPull(5), baseRefName: 'parent' }]),
      basePulls: readOk([{ ...headPull(4, 'sQVe'), baseRefName: 'main' }]),
    }),
  );

  expect(decision).toEqual({
    result: 'untracked',
    held: ['baseHasOpenPull'],
    chain: [
      { branch: 'parent', number: 4, url: 'https://github.com/sQVe/tau/pull/4' },
      { branch: 'feature', number: 5, url: 'https://github.com/sQVe/tau/pull/5' },
    ],
    basedOn: [],
    chainBase: 'main',
    githubStack: null,
  });
});

it('decides untracked when an open pull request is based on the branch', () => {
  const decision = decideGithub('feature', facts({ basedOn: readOk([basedOn(6, 'child')]) }));

  expect(decision).toMatchObject({
    result: 'untracked',
    held: ['openPullBasedOnBranch'],
    basedOn: [{ branch: 'child', number: 6 }],
    chainBase: 'main',
  });
});

it('decides untracked for a branch without a pull request that others are based on', () => {
  const decision = decideGithub(
    'feature',
    facts({ headPulls: readOk([]), stacks: null, basedOn: readOk([basedOn(6, 'child')]) }),
  );

  expect(decision).toMatchObject({
    result: 'untracked',
    chain: [{ branch: 'child', number: 6 }],
    chainBase: null,
  });
});

it('lists every reason that holds', () => {
  const decision = decideGithub(
    'feature',
    facts({
      headPulls: readOk([{ ...headPull(5), baseRefName: 'parent' }]),
      basedOn: readOk([basedOn(6, 'child')]),
      stacks: readOk({ kind: 'stack', number: 40, pullRequests: [4, 5, 6] }),
      basePulls: readOk([headPull(4, 'sQVe')]),
    }),
  );

  expect(decision).toMatchObject({
    held: ['githubStack', 'baseHasOpenPull', 'openPullBasedOnBranch'],
  });
});

it('decides unknown for several open pull requests from the push repository', () => {
  const decision = decideGithub(
    'feature',
    facts({ headPulls: readOk([headPull(5), headPull(7), headPull(8, 'someone')]), stacks: null }),
  );

  expect(decision).toMatchObject({
    result: 'unknown',
    reason: containing('#5, #7'),
  });
});

it.each([
  {
    name: 'the head pull requests',
    facts: { headPulls: readFailed('gh pr list', 'exited with code 1') },
  },
  {
    name: 'the pull requests based on the branch',
    facts: { basedOn: readFailed('gh pr list', 'boom') },
  },
  { name: 'the stacks API', facts: { stacks: readFailed('gh api', 'exited with code 1') } },
  {
    name: 'the base pull requests',
    facts: { basePulls: readFailed('gh pr list --head parent', 'boom') },
  },
])('decides unknown, never standalone, when $name cannot be read', ({ facts: failed }) => {
  const decision = decideGithub('feature', facts(failed));

  expect(decision.result).toBe('unknown');
});

it('decides unknown when a read failed even though a stack holds the pull request', () => {
  const decision = decideGithub(
    'feature',
    facts({
      stacks: readOk({ kind: 'stack', number: 40, pullRequests: [5] }),
      basedOn: readFailed('gh pr list --base', 'boom'),
    }),
  );

  expect(decision).toMatchObject({ result: 'unknown', reason: containing('boom') });
});
