import { expect, it, vi } from 'vitest';

import { judgeWithPanel, panelTimeoutMilliseconds } from './panelJudge.ts';
import type {
  JudgeQuestion,
  PanelMember,
  PanelPrompt,
  PanelReply,
  PastAnswer,
} from './questionGate.ts';

interface MemberCall {
  prompt: PanelPrompt;
  signal: AbortSignal;
}

const question: JudgeQuestion = {
  question: 'Which route?',
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [
    { label: 'Fast', description: 'Ship now.', recommended: true },
    { label: 'Careful', description: 'Check first.', recommended: false },
  ],
};

const options = [
  { label: 'Fast', description: 'Ship now.' },
  { label: 'Careful', description: 'Check first.' },
];

const memberFixture = (reply: () => Promise<PanelReply>) => {
  const calls: MemberCall[] = [];

  const member: PanelMember = (prompt, signal) => {
    calls.push({ prompt, signal });

    return reply();
  };

  return { member, calls };
};

const replying = (text: string) => memberFixture(() => Promise.resolve({ kind: 'replied', text }));

const deferredReply = () => {
  const settled = Promise.withResolvers<PanelReply>();

  return { promise: settled.promise, settle: settled.resolve };
};

it('starts every member before any finishes with distinct signals and no recommendation flag', async () => {
  const firstReply = deferredReply();
  const secondReply = deferredReply();
  const thirdReply = deferredReply();
  const first = memberFixture(() => firstReply.promise);
  const second = memberFixture(() => secondReply.promise);
  const third = memberFixture(() => thirdReply.promise);
  const members = [first.member, second.member, third.member] as const;

  const pending = judgeWithPanel(members, question, [], undefined);
  const calls = [first.calls, second.calls, third.calls];

  expect(calls.map((memberCalls) => memberCalls.length)).toEqual([1, 1, 1]);

  const signals = calls.map((memberCalls) => memberCalls[0]?.signal);

  expect(new Set(signals).size).toBe(3);

  for (const memberCalls of calls) {
    const user: unknown = JSON.parse(memberCalls[0]?.prompt.user ?? '{}');

    expect(user).not.toHaveProperty('recommended');
    expect(user).toMatchObject({ options });
  }

  firstReply.settle({ kind: 'replied', text: 'Fast' });
  secondReply.settle({ kind: 'replied', text: 'Fast' });
  thirdReply.settle({ kind: 'replied', text: 'Fast' });

  expect(await pending).toEqual({ kind: 'answered', confidence: 1 });
});

it('a member that ignores abort gives timeout and is aborted', async () => {
  vi.useFakeTimers();

  try {
    const hanging = memberFixture(() => new Promise(() => {}));
    const members = [replying('Fast').member, hanging.member, replying('Fast').member] as const;

    const pending = judgeWithPanel(members, question, [], undefined);

    await vi.advanceTimersByTimeAsync(panelTimeoutMilliseconds - 1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ kind: 'timeout' });
    expect(hanging.calls[0]?.signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('a rejected member promise gives error', async () => {
  const failing = memberFixture(() => Promise.reject(new Error('offline')));
  const members = [replying('Fast').member, failing.member, replying('Fast').member] as const;

  const verdict = await judgeWithPanel(members, question, [], undefined);

  expect(verdict).toEqual({ kind: 'error' });
});

it('a member returning unavailable gives unavailable', async () => {
  const unavailable = memberFixture(() => Promise.resolve({ kind: 'unavailable' }));
  const members = [replying('Fast').member, unavailable.member, replying('Fast').member] as const;

  const verdict = await judgeWithPanel(members, question, [], undefined);

  expect(verdict).toEqual({ kind: 'unavailable' });
});

it('a caller abort gives error', async () => {
  const hanging = memberFixture(() => new Promise(() => {}));
  const members = [hanging.member, replying('Fast').member, replying('Fast').member] as const;
  const controller = new AbortController();

  const pending = judgeWithPanel(members, question, [], controller.signal);
  controller.abort();

  expect(await pending).toEqual({ kind: 'error' });
  expect(hanging.calls[0]?.signal.aborted).toBe(true);
});

it('an already aborted caller starts no member', async () => {
  const first = replying('Fast');
  const second = replying('Fast');
  const third = replying('Fast');
  const members = [first.member, second.member, third.member] as const;
  const controller = new AbortController();

  controller.abort();

  const verdict = await judgeWithPanel(members, question, [], controller.signal);

  expect(verdict).toEqual({ kind: 'error' });
  expect([first.calls.length, second.calls.length, third.calls.length]).toEqual([0, 0, 0]);
});

it('the user prompt keeps examples but no current recommendation', async () => {
  const first = replying('Fast');
  const second = replying('Fast');
  const third = replying('Fast');
  const members = [first.member, second.member, third.member] as const;
  const past: PastAnswer = { time: 1, question, outcome: { kind: 'recommended' } };

  await judgeWithPanel(members, question, [past], undefined);

  for (const fixture of [first, second, third]) {
    const user: unknown = JSON.parse(fixture.calls[0]?.prompt.user ?? '{}');

    expect(user).not.toHaveProperty('recommended');

    expect(user).toMatchObject({
      options,
      examples: [
        {
          question: question.question,
          options,
          recommended: 'Fast',
          answer: 'recommended',
        },
      ],
    });
  }
});

it('the user prompt has no examples part when there are no examples', async () => {
  const first = replying('Fast');
  const second = replying('Fast');
  const third = replying('Fast');
  const members = [first.member, second.member, third.member] as const;

  await judgeWithPanel(members, question, [], undefined);

  for (const fixture of [first, second, third]) {
    const user: unknown = JSON.parse(fixture.calls[0]?.prompt.user ?? '{}');

    expect(user).not.toHaveProperty('examples');
  }
});
