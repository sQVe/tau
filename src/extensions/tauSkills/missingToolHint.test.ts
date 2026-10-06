import { expect, it } from 'vitest';

import { missingToolHint } from './missingToolHint.js';

const skillTools = {
  'code-review': ['code_review'],
  'pr-feedback': ['pr_feedback'],
};

it.each([
  {
    text: 'TypeError: tools.code_review does not exist. Available: read',
    skill: 'code-review',
    tool: 'code_review',
  },
  {
    text: 'tools.pr_feedback does not exist',
    skill: 'pr-feedback',
    tool: 'pr_feedback',
  },
  {
    text: 'tools.unknown does not exist\ntools.code_review does not exist',
    skill: 'code-review',
    tool: 'code_review',
  },
])('selects a missing skill tool hint for $text', ({ text, skill, tool }) => {
  const hint = missingToolHint(text, skillTools);

  expect(hint).toContain(skill);
  expect(hint).toContain('--tools');
  expect(hint).toContain('--exclude-tools');
  expect(hint).toContain(tool);
});

it.each([
  'tools.code_review_extra does not exist',
  'tools.unknown does not exist',
  'tools.code_review failed',
  '',
])('omits the hint for an unrelated error: %s', (text) => {
  expect(missingToolHint(text, skillTools)).toBeUndefined();
});
