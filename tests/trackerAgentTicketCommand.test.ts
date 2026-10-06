import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createLinearFake } from './linearFake.js';

const splitCommand = (command: string): string[] => {
  const words = command.match(/(?:[^\s']+|'[^']*')+/gu) ?? [];

  return words.map((word) => word.replace(/'([^']*)'/gu, '$1'));
};

it('creates an agent ticket with a digits-only string title under its slice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-tracker-command-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const descriptionFile = join(directory, 'description.md');

  await writeFile(descriptionFile, 'Carry out the slice task.\n');

  const skillPath = join(import.meta.dirname, '..', 'src', 'skills', 'tracker', 'SKILL.md');
  const skill = await readFile(skillPath, 'utf8');
  const blocks = [...skill.matchAll(/```sh\n([\s\S]*?)```/gu)];
  const createCommand = blocks.find((block) => block[1]!.includes('issueCreate'))?.[1];

  expect(createCommand).toBeDefined();

  const filledCommand = createCommand!
    .replace('<team id>', 'team-ai')
    .replace('<slice>', 'id-ME-1')
    .replace('<title>', '123')
    .replace('<file>', descriptionFile)
    .replace('["<label id>"]', '[]');

  const [command, ...commandArguments] = splitCommand(filledCommand);
  const linear = createLinearFake();

  linear.addIssue({ identifier: 'ME-1', title: 'Slice' });

  const result = await linear.exec(command!, commandArguments);

  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(linear.issues.get('ME-2')).toMatchObject({ title: '123', parent: 'ME-1' });
});
