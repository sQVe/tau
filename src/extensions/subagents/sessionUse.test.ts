import { expect, it } from 'vitest';

import { decideSessionUse } from './sessionUse.js';
import type {
  SessionUse,
  SessionUseAssignment,
  SessionUseFacts,
  SessionUseTerminal,
} from './sessionUse.js';

const sourceSessionFile = '/agent/assignments/source/session.jsonl';

const saved = (sessionFile: string): SessionUseAssignment => ({ kind: 'saved', sessionFile });

const terminal = (
  state: string,
  assignmentLabel: string | undefined,
  assignment: SessionUseAssignment,
): SessionUseTerminal => ({ state, assignmentLabel, assignment });

const facts = (...terminals: SessionUseTerminal[]): SessionUseFacts => ({
  sourceSessionFile,
  terminals,
});

const cases: { name: string; given: SessionUseFacts; expected: SessionUse }[] = [
  { name: 'no terminals', given: facts(), expected: 'free' },
  {
    name: 'finished same session',
    given: facts(terminal('finished', '/agent/one/assignment.json', saved(sourceSessionFile))),
    expected: 'free',
  },
  {
    name: 'running without a label',
    given: facts(terminal('live', undefined, { kind: 'none' })),
    expected: 'free',
  },
  {
    name: 'running with a different session',
    given: facts(
      terminal('live', '/agent/one/assignment.json', saved('/agent/other/session.jsonl')),
    ),
    expected: 'free',
  },
  {
    name: 'running with the source session',
    given: facts(terminal('live', '/agent/one/assignment.json', saved(sourceSessionFile))),
    expected: 'inUse',
  },
  {
    name: 'running with a missing assignment',
    given: facts(terminal('live', '/agent/one/assignment.json', { kind: 'missing' })),
    expected: 'unknown',
  },
  {
    name: 'running with a malformed assignment',
    given: facts(terminal('live', '/agent/one/assignment.json', { kind: 'malformed' })),
    expected: 'unknown',
  },
  {
    name: 'a failed hc read',
    given: facts(terminal('live', undefined, { kind: 'unread' })),
    expected: 'unknown',
  },
  {
    name: 'finished source and running other',
    given: facts(
      terminal('finished', '/agent/one/assignment.json', saved(sourceSessionFile)),
      terminal('live', '/agent/two/assignment.json', saved('/agent/other/session.jsonl')),
    ),
    expected: 'free',
  },
  {
    name: 'unknown before in-use',
    given: facts(
      terminal('live', '/agent/one/assignment.json', { kind: 'missing' }),
      terminal('live', '/agent/two/assignment.json', saved(sourceSessionFile)),
    ),
    expected: 'inUse',
  },
];

for (const { name, given, expected } of cases) {
  it(`decides ${name}`, () => {
    expect(decideSessionUse(given)).toBe(expected);
  });
}
