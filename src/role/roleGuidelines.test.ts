import { expect, it } from 'vitest';

import { leadOnlyGuidelines, managerGuidelines } from './roleGuidelines.js';

const qaGuidePath = '/tau/src/skills/shared/qa-guide.md';

const options = { loginCommand: undefined, qaProcedurePath: undefined, qaGuidePath };

it('adds one line that names the QA procedure and the guide only when given a procedure path', () => {
  const procedurePath = '/tau/src/skills/shared/qa-launch.md';
  const withGuide = managerGuidelines('lead', { ...options, qaProcedurePath: procedurePath });
  const withoutGuide = managerGuidelines('lead', options);
  const addedGuidelines = withGuide.filter((guideline) => !withoutGuide.includes(guideline));
  const sharedGuidelines = withGuide.filter((guideline) => withoutGuide.includes(guideline));

  expect(addedGuidelines).toHaveLength(1);
  expect(addedGuidelines[0]).toContain(procedurePath);
  expect(addedGuidelines[0]).toContain(qaGuidePath);
  expect(sharedGuidelines).toEqual(withoutGuide);
  expect(withoutGuide.some((guideline) => guideline.includes(qaGuidePath))).toBe(false);
});

it('asks the user for a failed or open-architect design answer before relaying one', () => {
  const designGuideline = managerGuidelines('lead', options).find((guideline) =>
    guideline.includes('For a handover question about design'),
  );

  expect(designGuideline).toBeDefined();

  const text = designGuideline ?? '';
  const sentences = text.split(/(?<=\.)\s+/u);
  const failedClause = sentences.find((sentence) => sentence.includes('`failed`')) ?? '';
  const relayClause = sentences.find((sentence) => sentence.includes("architect's answer")) ?? '';
  const unknownClauses = sentences.filter((sentence) => sentence.includes('`unknown`'));

  expect(failedClause).toContain('`Open the architect:`');
  expect(failedClause).toContain('`ask_user_question`');
  expect(failedClause).toContain('`handover_answer`');
  expect(failedClause).not.toContain('`open`');

  expect(failedClause.indexOf('`ask_user_question`')).toBeLessThan(
    failedClause.indexOf('`handover_answer`'),
  );

  expect(relayClause).not.toBe('');
  expect(sentences.indexOf(failedClause)).toBeLessThan(sentences.indexOf(relayClause));

  for (const clause of unknownClauses) {
    expect(sentences.indexOf(clause)).toBeLessThan(sentences.indexOf(relayClause));
  }

  const firstUnknown = unknownClauses[0] ?? '';
  const secondUnknown = unknownClauses[1] ?? '';

  expect(firstUnknown).toMatch(/retr/u);
  expect(firstUnknown).toContain('`askId`');
  expect(firstUnknown).not.toMatch(/new|different|another/u);
  expect(firstUnknown).not.toContain('`ask_user_question`');

  expect(secondUnknown).toContain('`ask_user_question`');
  expect(secondUnknown).toContain('`handover_answer`');
  expect(secondUnknown).not.toContain('`askId`');
});

it('keeps every lead-only guideline out of the architect set', () => {
  const leadOnly = leadOnlyGuidelines(options);
  const lead = managerGuidelines('lead', options);
  const architect = managerGuidelines('architect', options);

  expect(leadOnly.length).toBeGreaterThan(0);
  expect(lead).toEqual(expect.arrayContaining(leadOnly));

  for (const guideline of leadOnly) {
    expect(architect).not.toContain(guideline);
  }
});

it('sends a changed design fact to the architect from the lead guidelines only', () => {
  const changedFactGuideline =
    'When new evidence changes a fact the design rests on, send it to the architect before you write or file plan text, ticket bodies, or acceptance criteria.';

  const lead = managerGuidelines('lead', options);
  const architect = managerGuidelines('architect', options);

  expect(lead).toContain(changedFactGuideline);
  expect(architect).not.toContain(changedFactGuideline);
});

it('a lead guideline set names the lead rules and no architect rule', () => {
  const guidelines = managerGuidelines('lead', options);

  expect(guidelines).toContain(
    'You are the lead. You own the user conversation, launch briefs, integration, and commits.',
  );

  expect(guidelines).toContain(
    'Never edit code yourself, not even a small fix or an obvious rebase conflict. Send every code change to a `worker`.',
  );

  expect(guidelines.some((guideline) => guideline.includes('You are the architect.'))).toBe(false);

  expect(
    guidelines.some((guideline) =>
      guideline.includes('Do not edit code and do not launch an editing worker.'),
    ),
  ).toBe(false);
});

it('an architect guideline set names the architect rules and no lead rule', () => {
  const guidelines = managerGuidelines('architect', options);

  expect(guidelines).toContain(
    'You are the architect. You own how work is done: the design, the plan, the acceptance criteria, and the ticket bodies workers start from.',
  );

  expect(guidelines).toContain(
    'Do not edit code and do not launch an editing worker. Put each change in a ticket for the lead to delegate.',
  );

  expect(guidelines.some((guideline) => guideline.includes('You are the lead.'))).toBe(false);

  expect(guidelines.some((guideline) => guideline.includes('Never edit code yourself'))).toBe(
    false,
  );
});
