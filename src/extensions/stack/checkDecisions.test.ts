import { expect, it } from 'vitest';

import { decideStackView, readStacksResponse } from './checkDecisions.js';
import type { StackLayer, StackView, StackViewRead } from './checkDecisions.js';
import { readFailed, readOk } from './readResult.js';
import type { CommandOutput } from './readResult.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const layer = (name: string, flags: Partial<StackLayer> = {}): StackLayer => ({
  name,
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
  output(JSON.stringify([{ number, pull_requests: pullRequests }]));

const numbered = (...numbers: number[]) => numbers.map((number) => ({ number }));

it.each([
  { out: output('[]'), kind: 'none' },
  { out: stacksOutput(40, numbered(11, 12, 13)), kind: 'stack' },
  { out: output('', 1, 'gh: Not Found (HTTP 404)'), kind: 'off' },
])('reads the stacks API output as $kind', ({ out, kind }) => {
  expect(readStacksResponse('gh api', out)).toMatchObject({ ok: true, value: { kind } });
});

it('keeps the stack number and the pull request numbers of a stack in order', () => {
  expect(readStacksResponse('gh api', stacksOutput(40, numbered(3, 1, 2)))).toEqual(
    readOk({ kind: 'stack', number: 40, pullRequests: [3, 1, 2] }),
  );
});

it('reads a stack with an empty pull request list as no stack', () => {
  expect(readStacksResponse('gh api', stacksOutput(40, []))).toEqual(readOk({ kind: 'none' }));
});

it.each([
  { out: output('', 0), why: 'empty output' },
  { out: output('null'), why: 'null' },
  { out: output('[null]'), why: 'a list with null' },
  { out: output('{}'), why: 'an object' },
  { out: output('[{"pull_requests":[]}]'), why: 'a stack without a number' },
  { out: output('[{"number":17}]'), why: 'a stack without pull_requests' },
  { out: stacksOutput(17, null), why: 'pull_requests that is null' },
  { out: stacksOutput(17, { number: 1 }), why: 'pull_requests that is not a list' },
  { out: stacksOutput(40, [null]), why: 'a pull request entry that is null' },
  { out: stacksOutput(40, [{}]), why: 'a pull request entry without a number' },
  { out: stacksOutput(40, [{ number: 1 }, null]), why: 'a valid entry before a null entry' },
  {
    out: stacksOutput(40, [{ number: '1' }, { number: 2 }]),
    why: 'a bad entry before a valid one',
  },
  { out: stacksOutput(40, [{ number: '1' }]), why: 'string numbers' },
  { out: stacksOutput(40, [{ number: 1.5 }]), why: 'a fraction' },
  { out: stacksOutput('forty', numbered(1)), why: 'a stack number that is not a number' },
  { out: stacksOutput(null, numbered(1)), why: 'a null stack number' },
  { out: output('[{"number":1,'), why: 'cut off JSON' },
  { out: output('', 1, 'gh: Server Error (HTTP 500)'), why: 'an HTTP 500' },
  { out: output('', 4, 'authentication required'), why: 'no authentication' },
  { out: output('', null), why: 'a command that did not finish' },
])('fails the stacks API read for $why', ({ out }) => {
  expect(readStacksResponse('gh api', out)).toMatchObject({ ok: false, command: 'gh api' });
});
