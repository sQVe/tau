import type { PastAnswer } from '../../questionGate/questionGate.ts';

export const models = {
  classifier: 'tau-fixture/judge-a',
  panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b', 'tau-fixture/judge-c'] as [
    string,
    string,
    string,
  ],
};

export const question = (text = 'Which route?'): PastAnswer['question'] => ({
  question: text,
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [
    { label: 'Fast', description: 'Ship now.', recommended: true },
    { label: 'Careful', description: 'Check first.', recommended: false },
  ],
});

export const pastAnswer = (time: number, text: string, questionText?: string): PastAnswer => ({
  time,
  question: question(questionText),
  outcome: { kind: 'typed', text },
});
