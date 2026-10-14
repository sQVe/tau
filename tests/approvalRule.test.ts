import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { approvalProblem, splitSegments } from './approvalRule.js';

const skillsDirectory = resolve(import.meta.dirname, '../src/skills');

const link = '[Hard rules](../tracker/SKILL.md#hard-rules)';

describe('approvalProblem', () => {
  it.each([
    ['Post the reply to the reviewer on GitHub without asking.'],
    ['Cancel the duplicate without asking.'],
    ['Comment on the Linear ticket without asking.'],
    [`Cancel the duplicate without asking, as ${link} says.`],
    [`Reply to the reviewer on GitHub without asking, as ${link} says.`],
    ['Post the comment on the Linear ticket without\nasking.'],
    [`Post a GitHub review to Alice without asking, then reply to the bot, as ${link} says.`],
    [`Post the GitHub review without asking, as ${link} says. A bot also reads it.`],
    [`Reply to the author on GitHub and to the bot without asking, as ${link} says.`],
    [`Comment on another person's Linear ticket without asking, as ${link} says.`],
    [`Comment on a Linear ticket someone else owns without asking, as ${link} says.`],
  ])('rejects %s', (segment) => {
    expect(approvalProblem(segment)).toBeDefined();
  });

  it.each([
    [`Post the review comment to the Linear ticket without asking, as ${link} says.`],
    [`Reply to the GitHub bot without asking, as ${link} says.`],
    [
      "With findings on the user's own work, continue without asking: act on them with triage-findings.",
    ],
    ['Ask first before you comment on the ticket.'],
    [
      `Post the comment on the user's own Linear ticket without asking, as ${link} says. Ask first before cancelling a ticket.`,
    ],
  ])('accepts %s', (segment) => {
    expect(approvalProblem(segment)).toBeUndefined();
  });
});

describe('skills', () => {
  const skillNames = readdirSync(skillsDirectory).filter((name) =>
    existsSync(join(skillsDirectory, name, 'SKILL.md')),
  );

  it.each(skillNames.filter((name) => name !== 'tracker'))(
    '%s grants no write without asking beyond the tracker list',
    (name) => {
      const content = readFileSync(join(skillsDirectory, name, 'SKILL.md'), 'utf8');

      const problems = splitSegments(content).flatMap((segment) => {
        const problem = approvalProblem(segment);

        return problem === undefined ? [] : [`${problem}: ${segment}`];
      });

      expect(problems).toEqual([]);
    },
  );
});
