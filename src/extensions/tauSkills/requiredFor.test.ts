import { expect, it } from 'vitest';

import { requiredActions } from './requiredFor.js';

const skill = (name: string, frontmatter: Record<string, unknown>) => ({
  name,
  filePath: `/skills/${name}/SKILL.md`,
  frontmatter,
});

const requiredFor = (action: unknown) => ({ metadata: { 'required-for': action } });

it.each([
  { skills: [], actions: [] },
  { skills: [skill('bro', { name: 'bro' })], actions: [] },
  { skills: [skill('bro', { metadata: { author: 'tau' } })], actions: [] },
  {
    skills: [skill('pr', requiredFor(' opening a pull request\n'))],
    actions: [{ name: 'pr', action: 'opening a pull request' }],
  },
  {
    skills: [
      skill('pr', requiredFor('opening a pull request')),
      skill('bro', {}),
      skill('worktree', requiredFor('creating a Git worktree')),
    ],
    actions: [
      { name: 'pr', action: 'opening a pull request' },
      { name: 'worktree', action: 'creating a Git worktree' },
    ],
  },
])('lists one action per skill with required-for from $skills', ({ skills, actions }) => {
  expect(requiredActions(skills)).toEqual(actions);
});

it.each([
  { frontmatter: requiredFor('') },
  { frontmatter: requiredFor(' \n\t') },
  { frontmatter: requiredFor(42) },
  { frontmatter: requiredFor(['opening a pull request']) },
  { frontmatter: requiredFor(null) },
  { frontmatter: { metadata: 'required-for: opening a pull request' } },
  { frontmatter: { metadata: ['opening a pull request'] } },
  { frontmatter: { metadata: new Set(['required-for']) } },
])('rejects $frontmatter and names the skill file', ({ frontmatter }) => {
  expect(() => requiredActions([skill('bro', {}), skill('pr', frontmatter)])).toThrow(
    '/skills/pr/SKILL.md',
  );
});
