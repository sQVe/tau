import { readFileSync, readdirSync } from 'node:fs';
import type * as FileSystem from 'node:fs';

import { expect, it, onTestFinished, vi } from 'vitest';

import { skillTools, skillToolsPath } from '../../../skillTools.js';
import { layoutRoot, setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

const bundledToolNames = Object.values(skillTools).flat();

const changeSkillToolsOnDisk = async (result: string | Error) => {
  const actualFileSystem = await vi.importActual<typeof FileSystem>('node:fs');
  const readActual = actualFileSystem.readFileSync as (...values: unknown[]) => unknown;

  onTestFinished(() => {
    vi.mocked(readFileSync).mockReset();
  });

  vi.mocked(readFileSync).mockImplementation(((path: string, ...rest: unknown[]) => {
    if (path !== skillToolsPath) {
      return readActual(path, ...rest);
    }

    if (result instanceof Error) {
      throw result;
    }

    return result;
  }) as typeof readFileSync);
};

const workerToolsArgument = (calls: string[][]): string => {
  const command = layoutRoot(calls).command;

  return command[command.indexOf('--tools') + 1] ?? '';
};

it('launches when skillTools on disk changed but lists only registered tools', async () => {
  const fixture = setup(onTestFinished);

  await changeSkillToolsOnDisk('{ "tdd": ["pr_feedback"], "pr-feedback": [] }\n');

  const status = await fixture.controller.launch(fixture.input);

  expect(status.state).not.toBe('stopped');
  expect(fixture.calls.some((argumentsList) => argumentsList[0] === 'layout')).toBe(true);
});

it('gives the worker the tools that skillTools on disk assigns to its skill', async () => {
  const fixture = setup(onTestFinished);

  await changeSkillToolsOnDisk('{ "tdd": ["pr_feedback"] }\n');

  await fixture.controller.launch({
    ...fixture.input,
    loadout: { ...fixture.input.loadout, skills: ['/skills/tdd/SKILL.md'] },
  });

  expect(workerToolsArgument(fixture.calls).split(',')).toContain('pr_feedback');
});

it('gives the worker startup check the tool list that it passed to --tools', async () => {
  const fixture = setup(onTestFinished);

  await changeSkillToolsOnDisk('{ "tdd": ["pr_feedback"] }\n');

  await fixture.controller.launch({
    ...fixture.input,
    loadout: { ...fixture.input.loadout, skills: ['/skills/tdd/SKILL.md'] },
  });

  expect(JSON.parse(layoutRoot(fixture.calls).env.TAU_WORKER_TOOLS ?? '')).toEqual(
    workerToolsArgument(fixture.calls).split(','),
  );
});

it.each([
  {
    case: 'lists a tool the parent did not register',
    result: '{ "tdd": ["full_check", "mutation_check"] }\n',
    contains: ['mutation_check', '/reload'],
    excludes: [],
  },
  {
    case: 'cannot be parsed',
    result: '{ "tdd": ',
    contains: ['src/skillTools.json'],
    excludes: ['/reload'],
  },
  {
    case: 'cannot be read',
    result: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    contains: ['src/skillTools.json'],
    excludes: ['/reload'],
  },
])('refuses a launch when skillTools on disk $case', async ({ result, contains, excludes }) => {
  const fixture = setup(onTestFinished, 0, undefined, undefined, undefined, () =>
    bundledToolNames.filter((tool) => tool !== 'mutation_check'),
  );

  await changeSkillToolsOnDisk(result);

  const recordsBefore = readdirSync(fixture.directory);

  const launchResult = await fixture.controller
    .launch(fixture.input)
    .catch((error: unknown) => error);

  expect(launchResult).toBeInstanceOf(Error);

  for (const text of contains) {
    expect(String(launchResult)).toContain(text);
  }

  for (const text of excludes) {
    expect(String(launchResult)).not.toContain(text);
  }

  expect(readdirSync(fixture.directory)).toEqual(recordsBefore);
  expect(fixture.calls).toEqual([]);
});

it('launches when skillTools on disk matches the parent copy', async () => {
  const fixture = setup(onTestFinished);

  const status = await fixture.controller.launch(fixture.input);

  expect(status.state).not.toBe('stopped');
});
