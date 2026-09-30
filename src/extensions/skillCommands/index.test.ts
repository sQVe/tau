import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import skillCommandsExtension from './index.js';

const skillsDirectory = resolve(import.meta.dirname, '../../../skills');

describe('skillCommandsExtension', () => {
  it('registers a command for every skill directory', () => {
    const fake = fakeExtensionApi();

    skillCommandsExtension(fake.pi);

    const skillNames = readdirSync(skillsDirectory).filter((name) =>
      existsSync(join(skillsDirectory, name, 'SKILL.md')),
    );

    expect([...fake.commands.keys()].toSorted()).toEqual(skillNames.toSorted());
  });

  it('sends skill messages as follow-ups when idle and steering messages when busy', async () => {
    const fake = fakeExtensionApi();

    skillCommandsExtension(fake.pi);

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
});
