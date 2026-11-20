import type { JsonObject } from '@earendil-works/pi-ai';

import { questionExamples, questionOptions, recommendedLabel } from './classifierJudge.ts';
import { panelVerdict } from './panelVerdict.ts';
import type { MemberResult } from './panelVerdict.ts';
import type {
  JudgeQuestion,
  JudgeVerdict,
  PanelMember,
  PanelPrompt,
  PastAnswer,
} from './questionGate.ts';

export const panelTimeoutMilliseconds = 30_000;

const systemPrompt =
  'You predict which option this user picks. Reply with the exact label of one option and nothing else.';

const userPrompt = (question: JudgeQuestion, examples: readonly PastAnswer[]): string => {
  const state: JsonObject = {
    question: question.question,
    problem: question.problem,
    impact: question.impact,
    options: questionOptions(question),
  };

  if (examples.length > 0) {
    state.examples = questionExamples(examples);
  }

  return JSON.stringify(state);
};

const memberResult = async (
  member: PanelMember,
  prompt: PanelPrompt,
  callerSignal: AbortSignal | undefined,
): Promise<MemberResult> => {
  if (callerSignal?.aborted === true) {
    return { kind: 'error' };
  }

  const controller = new AbortController();
  const stopped = Promise.withResolvers<MemberResult>();

  const stop = (result: MemberResult) => {
    controller.abort();
    stopped.resolve(result);
  };

  const timer = setTimeout(() => {
    stop({ kind: 'timeout' });
  }, panelTimeoutMilliseconds);

  const cancel = () => {
    stop({ kind: 'error' });
  };

  callerSignal?.addEventListener('abort', cancel, { once: true });

  try {
    const reply = member(prompt, controller.signal).catch((): MemberResult => ({ kind: 'error' }));

    return await Promise.race([reply, stopped.promise]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
};

export const judgeWithPanel = async (
  members: readonly [PanelMember, PanelMember, PanelMember],
  question: JudgeQuestion,
  examples: readonly PastAnswer[],
  signal: AbortSignal | undefined,
): Promise<JudgeVerdict> => {
  const prompt: PanelPrompt = { system: systemPrompt, user: userPrompt(question, examples) };
  const results = await Promise.all(members.map((member) => memberResult(member, prompt, signal)));
  const labels = question.options.map((option) => option.label);

  return panelVerdict(results, labels, recommendedLabel(question.options));
};
