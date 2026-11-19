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

it('three members pick the recommended label', async () => {
  const first = replying('Fast');
  const second = replying('Fast');
  const third = replying('Fast');
  const members = [first.member, second.member, third.member] as const;

  const verdict = await judgeWithPanel(members, question, [], undefined);

  expect(verdict).toEqual({ kind: 'answered', confidence: 1 });
  expect(second.calls[0]?.prompt).toEqual(first.calls[0]?.prompt);
  expect(third.calls[0]?.prompt).toEqual(first.calls[0]?.prompt);
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

it('a caller abort gives error', async () => {
  const hanging = memberFixture(() => new Promise(() => {}));
  const members = [hanging.member, replying('Fast').member, replying('Fast').member] as const;
  const controller = new AbortController();

  const pending = judgeWithPanel(members, question, [], controller.signal);
  controller.abort();

  expect(await pending).toEqual({ kind: 'error' });
  expect(hanging.calls[0]?.signal.aborted).toBe(true);
});

it('the user prompt has no recommended field for the current question and keeps it in examples', async () => {
  const first = replying('Fast');
  const members = [first.member, replying('Fast').member, replying('Fast').member] as const;
  const past: PastAnswer = { time: 1, question, outcome: { kind: 'recommended' } };

  await judgeWithPanel(members, question, [past], undefined);

  const prompt = first.calls[0]?.prompt;

  expect(prompt?.system).toBe(
    'You predict which option this user picks. Reply with the exact label of one option and nothing else.',
  );

  const user: unknown = JSON.parse(prompt?.user ?? '{}');

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
});
