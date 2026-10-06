import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendedSystemPrompt, fakeExtensionApi } from '../../../tests/extensionApi.js';
import tauSkillsExtension from './tauSkills.js';

const skillsDirectory = resolve(import.meta.dirname, '../../skills');

afterEach(() => vi.unstubAllEnvs());

const skillNames = readdirSync(skillsDirectory).filter((name) =>
  existsSync(join(skillsDirectory, name, 'SKILL.md')),
);

const requiredForOf = (skillName: string) => {
  const content = readFileSync(join(skillsDirectory, skillName, 'SKILL.md'), 'utf8');

  const { metadata } = parseFrontmatter<{ metadata?: Record<string, unknown> }>(
    content,
  ).frontmatter;

  return metadata?.['required-for'];
};

describe('tauSkillsExtension', () => {
  it('registers a command for every skill directory', () => {
    const fake = fakeExtensionApi();

    tauSkillsExtension(fake.pi, skillsDirectory);

    expect([...fake.commands.keys()].toSorted()).toEqual(skillNames.toSorted());
  });

  it('sends skill messages as follow-ups when idle and steering messages when busy', async () => {
    const fake = fakeExtensionApi();

    tauSkillsExtension(fake.pi, skillsDirectory);

    const broCommand = fake.commands.get('bro');

    if (broCommand == null) {
      throw new Error('Expected bro command to be registered');
    }

    await broCommand.handler('the test failure', { isIdle: () => true } as never);
    await broCommand.handler('', { isIdle: () => true } as never);
    await broCommand.handler('', { isIdle: () => false } as never);

    expect(fake.sendUserMessage.mock.calls).toEqual([
      ['/skill:bro the test failure', { deliverAs: 'followUp', expandPromptTemplates: true }],
      ['/skill:bro', { deliverAs: 'followUp', expandPromptTemplates: true }],
      ['/skill:bro', { deliverAs: 'steer', expandPromptTemplates: true }],
    ]);
  });

  it('names only the skills with required-for in the system prompt', () => {
    const fake = fakeExtensionApi();

    tauSkillsExtension(fake.pi, skillsDirectory);

    const prompt = appendedSystemPrompt(fake.handlers, []);
    const namedSkills = skillNames.filter((name) => prompt.includes(`\`${name}\``));
    const requiredSkills = skillNames.filter((name) => requiredForOf(name) !== undefined);

    expect(requiredSkills).toEqual(
      expect.arrayContaining([
        'handover',
        'pr',
        'pr-feedback',
        'stack',
        'update-branch',
        'worktree',
      ]),
    );

    expect(namedSkills).toEqual(requiredSkills);
    expect(prompt.split('\n')).toHaveLength(requiredSkills.length);

    for (const name of requiredSkills) {
      expect(prompt).toContain(String(requiredForOf(name)));
    }
  });

  it('adds no system prompt text in a worker process but keeps the commands', () => {
    vi.stubEnv('TAU_WORKER_RECORD', '/records/task-one');
    const fake = fakeExtensionApi();

    tauSkillsExtension(fake.pi, skillsDirectory);

    expect(appendedSystemPrompt(fake.handlers, [])).toBe('');
    expect([...fake.commands.keys()].toSorted()).toEqual(skillNames.toSorted());
  });

  it.for([
    { problem: 'malformed YAML', metadata: '  required-for: [opening a pull request' },
    { problem: 'an empty required-for', metadata: "  required-for: ''" },
    { problem: 'a non-string required-for', metadata: '  required-for: 42' },
  ])(
    'refuses to load a skill with $problem and registers nothing',
    async ({ metadata }, { onTestFinished }) => {
      const directory = await mkdtemp(join(tmpdir(), 'tau-skills-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));

      const writeSkill = async (name: string, frontmatter: string) => {
        await mkdir(join(directory, name));

        await writeFile(
          join(directory, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Test the ${name} skill.\n${frontmatter}\n---\n\nBody.\n`,
        );
      };

      await writeSkill('good', 'metadata:\n  required-for: opening a pull request');
      await writeSkill('broken', `metadata:\n${metadata}`);
      const fake = fakeExtensionApi();

      expect(() => {
        tauSkillsExtension(fake.pi, directory);
      }).toThrow(join(directory, 'broken', 'SKILL.md'));

      expect(fake.commands.size).toBe(0);
      expect(fake.handlers.size).toBe(0);
    },
  );
});
