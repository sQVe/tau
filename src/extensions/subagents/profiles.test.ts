import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import {
  listProfiles,
  parseProfile,
  resolveProfile,
  workerInstructions,
  workerPrompt,
} from './profiles.js';
import type { Task } from './types.js';

const agentsFixture = (onTestFinished: (callback: () => void) => void) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-profiles-test-');

  const agents = join(directory, 'agents');
  mkdirSync(agents);

  return {
    directory,
    write: (file: string, text: string) => {
      writeFileSync(join(agents, file), text);
    },
  };
};

const task = (acceptance?: string[]) =>
  ({
    taskId: 'task-1',
    task: 'Fix the parser.',
    deadline: 1_700_000_000_000,
    ...(acceptance === undefined ? {} : { acceptance }),
  }) as Task;

it('lists acceptance criteria in order under the task', () => {
  const prompt = workerPrompt(task(['Parses empty input.', 'Keeps the old API.']));

  expect(prompt).toContain(
    'Fix the parser.\n\nAcceptance criteria:\n1. Parses empty input.\n2. Keeps the old API.\n\nDeadline:',
  );
});

it('adds no criteria section when the task has none', () => {
  expect(workerPrompt(task())).not.toContain('Acceptance criteria');
});

it('ends the worker system prompt with a safety directive after the contracts', () => {
  const loadout = fixtureLoadout('/work');
  const prompt = workerInstructions(loadout);
  const directive = prompt.split('\n\n').at(-1) ?? '';

  expect(directive).not.toBe('');
  expect(directive).not.toContain(loadout.instructions);
});

const parse = (content: string) => parseProfile(content, 'fixture', 'fixture.md');

it('refuses a profile whose instructions are blank', () => {
  expect(() => parse('---\nrole: editing\n---\n \n\t\n')).toThrow('empty');
});

it('trims the instructions of a profile', () => {
  expect(parse('---\nrole: editing\n---\n\n  Do it.  \n\n').instructions).toBe('Do it.');
});

it('reads a profile with CRLF line endings', () => {
  const profile = parse('---\r\nname: crlf\r\nrole: editing\r\n---\r\nDo it.\r\n');

  expect(profile).toMatchObject({ name: 'crlf', role: 'editing', instructions: 'Do it.' });
});

it('refuses text before the frontmatter', () => {
  expect(() => parse('Intro\n---\nrole: editing\n---\nTask')).toThrow('Invalid profile');
});

it('refuses an indented setting line', () => {
  expect(() => parse('---\n role: editing\n---\nTask')).toThrow('Malformed');
});

it('refuses a malformed setting line that ends in a Unicode line separator', () => {
  expect(() => parse('---\nrole: editing\u2028garbage\n---\nTask')).toThrow('Malformed');
});

it('accepts a setting with no space after the colon and trims trailing spaces', () => {
  const profile = parse('---\nrole:editing   \nthinking: high  \n---\nTask');

  expect(profile).toMatchObject({ role: 'editing', thinking: 'high' });
});

it('lists and resolves a profile by file name, ignoring files that are not markdown', ({
  onTestFinished,
}) => {
  const { directory, write } = agentsFixture(onTestFinished);

  write('triage.md', '---\nrole: editing\n---\nTriage.');
  write('notes.txt', '---\nname: notes\n---\nNot a profile.');

  const names = listProfiles(directory, directory, false).map(({ name }) => name);

  expect(names).toContain('triage');
  expect(names).not.toContain('notes');
  expect(resolveProfile(directory, directory, false, 'triage')?.instructions).toBe('Triage.');
});

it('lists a CRLF profile by its name and description, trimmed', ({ onTestFinished }) => {
  const { directory, write } = agentsFixture(onTestFinished);

  write(
    'file.md',
    '---\r\nname: sorter  \r\ndescription: Sorts bugs  \r\nrole: editing\r\n---\r\nTask',
  );

  expect(listProfiles(directory, directory, false)).toContainEqual({
    name: 'sorter',
    description: 'Sorts bugs',
  });
});

it('reads no name from text that is not frontmatter', ({ onTestFinished }) => {
  const { directory, write } = agentsFixture(onTestFinished);

  write('plain.md', 'Intro\n---\nname: hidden\ndescription: sneaky\n---\nBody');

  const listed = listProfiles(directory, directory, false);

  expect(listed).toContainEqual({ name: 'plain' });
  expect(listed.find(({ name }) => name === 'plain')).not.toHaveProperty('description');
  expect(listed.map(({ name }) => name)).not.toContain('hidden');
});

it('lists a profile whose frontmatter is never closed by its name', ({ onTestFinished }) => {
  const { directory, write } = agentsFixture(onTestFinished);

  write('file.md', '---\nname: renamed\nrole: editing');

  const names = listProfiles(directory, directory, false).map(({ name }) => name);

  expect(names).toContain('renamed');
});
