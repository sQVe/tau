import { describe, expect, it } from 'vitest';

import type { Comment, Review, Thread } from './threads.js';
import { personWrites, planWrites } from './writes.js';
import type { WriteFacts } from './writes.js';

const thread = (id: string, change: Partial<Thread> = {}): Thread => ({
  id,
  path: 'src/tau.ts',
  line: 12,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  replyTo: 101,
  fromPerson: true,
  startedByViewer: false,
  comments: [
    {
      id: 101,
      author: 'reviewer',
      isBot: false,
      body: 'Rename this.',
      url: `https://github.com/sQVe/tau/pull/7#${id}`,
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-01T10:00:00Z',
    },
  ],
  ...change,
});

const review = (id: number, isBot: boolean): Review => ({
  id,
  author: isBot ? 'coderabbitai' : 'reviewer',
  isBot,
  state: 'COMMENTED',
  body: 'Summary.',
  url: `https://github.com/sQVe/tau/pull/7#pullrequestreview-${id}`,
});

const comment = (id: number, isBot: boolean): Comment => ({
  id,
  author: isBot ? 'coderabbitai' : 'reviewer',
  isBot,
  body: 'Question.',
  url: `https://github.com/sQVe/tau/pull/7#issuecomment-${id}`,
});

const prUrl = 'https://github.com/sQVe/tau/pull/7';

const facts = (change: Partial<WriteFacts>): WriteFacts => ({
  entries: [],
  comment: null,
  threads: [thread('person'), thread('bot', { fromPerson: false, replyTo: 201 })],
  reviews: [review(401, true), review(402, false)],
  comments: [comment(301, false), comment(302, true)],
  prUrl,
  recorded: [],
  ...change,
});

const url = (id: string) => `https://github.com/sQVe/tau/pull/7#${id}`;

describe('planWrites', () => {
  it.each([
    {
      case: 'reply and resolve in file order, PR comment last',
      facts: facts({
        entries: [
          { id: 'bot', reply: null, resolve: true },
          { id: 'person', reply: 'Renamed.', resolve: true },
        ],
        comment: { body: 'Thanks.', answers: ['401'] },
      }),
      writes: [
        { kind: 'resolve', thread: 'bot', url: url('bot'), text: null, toPerson: false },
        {
          kind: 'reply',
          thread: 'person',
          url: url('person'),
          replyTo: 101,
          text: 'Renamed.',
          toPerson: true,
        },
        { kind: 'resolve', thread: 'person', url: url('person'), text: null, toPerson: true },
        { kind: 'comment', thread: null, url: prUrl, text: 'Thanks.', toPerson: false },
      ],
    },
    {
      case: 'reply to a bot thread without resolving',
      facts: facts({ entries: [{ id: 'bot', reply: 'Done.', resolve: false }] }),
      writes: [
        {
          kind: 'reply',
          thread: 'bot',
          url: url('bot'),
          replyTo: 201,
          text: 'Done.',
          toPerson: false,
        },
      ],
    },
    {
      case: 'PR comment answering a person review',
      facts: facts({ comment: { body: 'Done.', answers: ['401', '402'] } }),
      writes: [{ kind: 'comment', thread: null, url: prUrl, text: 'Done.', toPerson: true }],
    },
    {
      case: 'PR comment answering a person conversation comment',
      facts: facts({ comment: { body: 'Done.', answers: ['301'] } }),
      writes: [{ kind: 'comment', thread: null, url: prUrl, text: 'Done.', toPerson: true }],
    },
    {
      case: 'PR comment answering only bots',
      facts: facts({ comment: { body: 'Done.', answers: ['302', '401'] } }),
      writes: [{ kind: 'comment', thread: null, url: prUrl, text: 'Done.', toPerson: false }],
    },
    {
      case: 'PR comment answering nothing',
      facts: facts({ comment: { body: 'Done.', answers: [] } }),
      writes: [{ kind: 'comment', thread: null, url: prUrl, text: 'Done.', toPerson: true }],
    },
    {
      case: 'recorded reply leaves the resolve',
      facts: facts({
        entries: [{ id: 'person', reply: 'Renamed.', resolve: true }],
        recorded: [{ kind: 'reply', thread: 'person' }],
      }),
      writes: [
        { kind: 'resolve', thread: 'person', url: url('person'), text: null, toPerson: true },
      ],
    },
    {
      case: 'recorded thread that is resolved now, and recorded PR comment',
      facts: facts({
        entries: [{ id: 'gone', reply: 'Renamed.', resolve: true }],
        comment: { body: 'Thanks.', answers: ['999'] },
        recorded: [
          { kind: 'reply', thread: 'gone' },
          { kind: 'resolve', thread: 'gone' },
          { kind: 'comment', thread: null },
        ],
      }),
      writes: [],
    },
  ])('plans $case', ({ facts: given, writes }) => {
    expect(planWrites(given)).toEqual(writes);
  });

  it.each([
    {
      case: 'an unknown or resolved thread',
      facts: facts({ entries: [{ id: 'gone', reply: 'Hi.', resolve: false }] }),
      error: 'Thread gone in replies.json is not an unresolved thread on the pull request.',
    },
    {
      case: 'a thread listed twice',
      facts: facts({
        entries: [
          { id: 'person', reply: 'Hi.', resolve: false },
          { id: 'person', reply: null, resolve: true },
        ],
      }),
      error: 'replies.json lists thread person more than once.',
    },
    {
      case: 'an entry with no reply and no resolve',
      facts: facts({ entries: [{ id: 'person', reply: null, resolve: false }] }),
      error: 'Thread person in replies.json has no reply and does not resolve.',
    },
    {
      case: 'a reply the viewer cannot make',
      facts: facts({
        entries: [{ id: 'locked', reply: 'Hi.', resolve: false }],
        threads: [thread('locked', { viewerCanReply: false })],
      }),
      error: 'Thread locked in replies.json has a reply, but you cannot reply to it.',
    },
    {
      case: 'a resolve the viewer cannot make',
      facts: facts({
        entries: [{ id: 'locked', reply: null, resolve: true }],
        threads: [thread('locked', { viewerCanResolve: false })],
      }),
      error: 'Thread locked in replies.json resolves, but you cannot resolve it.',
    },
    {
      case: 'an unknown answers ID',
      facts: facts({ comment: { body: 'Hi.', answers: ['301', '999'] } }),
      error: 'The comment in replies.json answers 999, which is no review or comment',
    },
  ])('rejects $case', ({ facts: given, error }) => {
    expect(() => planWrites(given)).toThrow(error);
  });
});

describe('personWrites', () => {
  it('keeps only the writes that go to a person', () => {
    const writes = planWrites(
      facts({
        entries: [
          { id: 'bot', reply: 'Done.', resolve: true },
          { id: 'person', reply: null, resolve: true },
        ],
      }),
    );

    expect(personWrites(writes)).toEqual([
      { kind: 'resolve', thread: 'person', url: url('person'), text: null, toPerson: true },
    ]);
  });
});
