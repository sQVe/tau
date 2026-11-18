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

it('routes a confident gate open to the architect and asks the user only when uncertain', () => {
  const guidelines = managerGuidelines('lead', options);
  const gateGuideline = guidelines.find((guideline) => guideline.includes('`architect` `gate`'));

  expect(gateGuideline).toContain('On `open`, call `architect` `open`.');
  expect(gateGuideline).toContain('On `uncertain`, ask the user');
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

it('a lead guideline set names the lead rules and no architect rule', () => {
  const guidelines = managerGuidelines('lead', options);

  expect(guidelines).toContain(
    'You are the lead. You own the user conversation, the worker briefs, integration, and commits.',
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
    'You are the architect. You own how work is done: the design, the plan, the acceptance criteria, and the worker briefs.',
  );

  expect(guidelines).toContain(
    'Do not edit code and do not launch an editing worker. Put each change in a ticket for the lead to delegate.',
  );

  expect(guidelines).toContain(
    'You may launch investigation workers, such as `scout`, to answer a design question.',
  );

  expect(guidelines.some((guideline) => guideline.includes('You are the lead.'))).toBe(false);

  expect(guidelines.some((guideline) => guideline.includes('Never edit code yourself'))).toBe(
    false,
  );
});
