import { expect, it } from 'vitest';

import { mutationPassed, runWasStopped } from './mutationVerdict.js';
import type { MutationRunFacts } from './mutationVerdict.js';

const facts = (overrides: Partial<MutationRunFacts>): MutationRunFacts => ({
  status: 'pass',
  hasUnmutated: false,
  exitCode: 0,
  idle: false,
  ...overrides,
});

it.each([
  { name: 'pass', facts: facts({}), passed: true },
  { name: 'nothing', facts: facts({ status: 'nothing' }), passed: true },
  { name: 'survivors', facts: facts({ status: 'survivors', exitCode: 2 }), passed: true },
  { name: 'survivors in audit mode', facts: facts({ status: 'survivors' }), passed: true },
  {
    name: 'survivors with exit 1',
    facts: facts({ status: 'survivors', exitCode: 1 }),
    passed: false,
  },
  {
    name: 'survivors with a signal',
    facts: facts({ status: 'survivors', exitCode: null }),
    passed: false,
  },
  {
    name: 'survivors with an idle stop',
    facts: facts({ status: 'survivors', exitCode: 2, idle: true }),
    passed: false,
  },
  {
    name: 'survivors with unmutated files',
    facts: facts({ status: 'survivors', exitCode: 2, hasUnmutated: true }),
    passed: false,
  },
  { name: 'pass with exit 2', facts: facts({ exitCode: 2 }), passed: false },
  { name: 'error', facts: facts({ status: 'error', exitCode: 1 }), passed: false },
  { name: 'error with exit 0', facts: facts({ status: 'error' }), passed: false },
  { name: 'pass with a nonzero exit', facts: facts({ exitCode: 1 }), passed: false },
  { name: 'a signal', facts: facts({ exitCode: null }), passed: false },
  { name: 'an idle stop', facts: facts({ idle: true }), passed: false },
  { name: 'no report', facts: facts({ status: undefined }), passed: false },
])('judges $name', ({ facts: given, passed }) => {
  expect(mutationPassed(given)).toBe(passed);
});

it.each([
  { name: 'a normal exit', facts: { idle: false, exitCode: 0 }, stopped: false },
  { name: 'a failing exit', facts: { idle: false, exitCode: 2 }, stopped: false },
  { name: 'a signal', facts: { idle: false, exitCode: null }, stopped: true },
  { name: 'an idle stop', facts: { idle: true, exitCode: 0 }, stopped: true },
])('reports a stop for $name as $stopped', ({ facts: given, stopped }) => {
  expect(runWasStopped(given)).toBe(stopped);
});
