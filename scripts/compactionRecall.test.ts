import { expect, it } from 'vitest';

import { compactionRecall, extractFacts } from './compactionRecall.js';
import type { Entry } from './tokenUsageReport.js';

interface Later {
  role: string;
  content: string;
}

interface Session {
  replaced: string;
  summary?: string;
  kept?: string;
  after?: Later[];
}

const timestamp = '2026-09-01T10:00:00.000Z';

const message = (id: string, parentId: string, role: string, content: string): Entry => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: { role, content: [{ type: 'text', text: content }] },
});

const compaction = (id: string, parentId: string, firstKeptEntryId: string, summary: string) => ({
  type: 'compaction',
  id,
  parentId,
  timestamp,
  summary,
  firstKeptEntryId,
  tokensBefore: 200_000,
});

// A session of: header, a replaced user message, a kept user message, the compaction, and the
// later entries in one chain.
const session = ({ replaced, summary = '', kept = '', after = [] }: Session) => {
  const entries: Entry[] = [
    { type: 'session', id: 'header', timestamp },
    message('replaced', 'header', 'user', replaced),
    message('kept', 'replaced', 'user', kept),
    compaction('compaction', 'kept', 'kept', summary),
    ...after.map((later, index) =>
      message(
        `after${index}`,
        index === 0 ? 'compaction' : `after${index - 1}`,
        later.role,
        later.content,
      ),
    ),
  ];

  return { entries, index: 3 };
};

const facts = (source: string) =>
  [...extractFacts(source).values()].map((fact) => `${fact.kind} ${fact.value}`).toSorted();

it.each([
  {
    rule: 'reads a UUID in any case without its segments as SHAs',
    source: 'Task 1BAC2FF2-618e-440a-a45e-777cfdb99177 ready.',
    found: ['uuid 1bac2ff2-618e-440a-a45e-777cfdb99177'],
  },
  {
    rule: 'shortens a SHA to 7 characters',
    source: 'Commit a8b6483f00 landed.',
    found: ['sha a8b6483'],
  },
  { rule: 'skips hex without a digit', source: 'deadbeefcafe', found: [] },
  { rule: 'skips a number without a hex letter', source: 'port 1234567', found: [] },
  { rule: 'skips a color', source: 'color: #aabb1234;', found: [] },
  { rule: 'skips hex inside a slug', source: 'branch fix-1a2b3c4', found: [] },
  {
    rule: 'reads a .tau path from .tau on',
    source: 'Read /home/u/repo/.tau/brief.md.',
    found: ['path .tau/brief.md'],
  },
  {
    rule: 'reads a worktree without its sentence dot',
    source: 'Work in /home/u/code/tau/me-466.',
    found: ['path /home/u/code/tau/me-466'],
  },
  { rule: 'skips a file path outside .tau', source: 'Edit /home/u/code/tau/x.ts', found: [] },
  {
    rule: 'reads PR numbers from each form',
    source: 'PR 216, https://github.com/o/r/pull/217, and #218',
    found: ['pr #216', 'pr #217', 'pr #218'],
  },
  { rule: 'skips an issue reference in a URL fragment', source: 'page&#123', found: [] },
  {
    rule: 'reads a Linear ID but no standard name',
    source: 'ME-466 uses UTF-8.',
    found: ['linear ME-466'],
  },
])('$rule', ({ source, found }) => {
  expect(facts(source)).toEqual(found);
});

it.each([
  {
    rule: 'counts a fact the summary kept',
    session: {
      replaced: 'Start ME-466.',
      summary: 'Working on ME-466.',
      after: [{ role: 'assistant', content: 'ME-466 is done.' }],
    },
    counts: { needed: 1, summary: 1, kept: 0, lost: 0 },
    lost: [],
  },
  {
    rule: 'counts a fact the kept entries hold',
    session: {
      replaced: 'Start ME-466.',
      kept: 'Still ME-466.',
      after: [{ role: 'assistant', content: 'ME-466 is done.' }],
    },
    counts: { needed: 1, summary: 0, kept: 1, lost: 0 },
    lost: [],
  },
  {
    rule: 'records where a lost fact first came back',
    session: {
      replaced: 'Start ME-466.',
      after: [
        { role: 'toolResult', content: 'ME-466: open' },
        { role: 'assistant', content: 'ME-466 is open.' },
      ],
    },
    counts: { needed: 1, summary: 0, kept: 0, lost: 1 },
    lost: [{ kind: 'linear', value: 'ME-466', returnedThrough: 'tool result' }],
  },
  {
    rule: 'records a lost fact the assistant repeated first',
    session: {
      replaced: 'Start ME-466.',
      after: [{ role: 'assistant', content: 'Back to ME-466.' }],
    },
    counts: { needed: 1, summary: 0, kept: 0, lost: 1 },
    lost: [{ kind: 'linear', value: 'ME-466', returnedThrough: 'assistant' }],
  },
  {
    rule: 'ignores a fact that never comes back',
    session: { replaced: 'Start ME-466.', after: [{ role: 'user', content: 'Thanks.' }] },
    counts: { needed: 0, summary: 0, kept: 0, lost: 0 },
    lost: [],
  },
  {
    rule: 'ignores a fact that first appears after the compaction',
    session: { replaced: 'Start.', after: [{ role: 'user', content: 'Now ME-467.' }] },
    counts: { needed: 0, summary: 0, kept: 0, lost: 0 },
    lost: [],
  },
])('$rule', ({ session: input, counts, lost }) => {
  const { entries, index } = session(input);
  const recall = compactionRecall(entries, index);

  expect(recall?.counts.get('linear')).toEqual(counts);
  expect(recall?.lost).toEqual(lost);
});

it('ignores entries on another branch', () => {
  const { entries, index } = session({ replaced: 'Start ME-466.' });

  entries.push(message('branch', 'kept', 'assistant', 'ME-466 on the old branch.'));

  expect(compactionRecall(entries, index)?.counts.get('linear')?.needed).toBe(0);
});

it("replaces the previous compaction's summary and its kept entries", () => {
  const entries: Entry[] = [
    { type: 'session', id: 'header', timestamp },
    message('old', 'header', 'user', 'Old ME-1.'),
    compaction('first', 'old', 'first', 'Summary with ME-2.'),
    message('replaced', 'first', 'user', 'Replaced ME-3.'),
    message('kept', 'replaced', 'user', 'Kept.'),
    compaction('second', 'kept', 'kept', ''),
    message('later', 'second', 'toolResult', 'ME-1 ME-2 ME-3'),
  ];

  const lost = compactionRecall(entries, 5)?.lost.map((fact) => fact.value);

  expect(lost?.toSorted()).toEqual(['ME-2', 'ME-3']);
});

it('returns undefined when the kept entry is not on the path', () => {
  const { entries, index } = session({ replaced: 'Start ME-466.' });

  entries[index] = compaction('compaction', 'kept', 'missing', '');

  expect(compactionRecall(entries, index)).toBeUndefined();
});
