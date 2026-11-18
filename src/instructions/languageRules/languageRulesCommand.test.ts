import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { writeStommeProject } from '../../../tests/stommeProjectHarness.js';
import {
  bundledRules,
  delivered,
  languageCases,
  runLanguageCommand,
  setupLanguageRules,
} from './fixtures/languageRulesHarness.js';

for (const { language, label, customType, command } of languageCases) {
  const rules = bundledRules(language);

  it.for([true, false])(
    `activates ${label} rules with the command and idle state %s`,
    async (idle, { onTestFinished }) => {
      const fixture = await setupLanguageRules(onTestFinished);

      fixture.idle.mockReturnValue(idle);
      const registered = fixture.api.commands.get(command);

      expect(registered).toBeDefined();
      await registered?.handler('', fixture.context as ExtensionCommandContext);

      expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, {
        version: 1,
      });

      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(label),
        'info',
      );

      const messageCount = idle ? 0 : 1;

      expect(fixture.api.sendMessage).toHaveBeenCalledTimes(messageCount);
      expect(await fixture.prompt()).toBe(rules);
    },
  );

  it(`reports a stomme project's ${label} guide as loaded without activating rules`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await writeStommeProject(fixture.directory, { language });
    await fixture.prompt();
    await runLanguageCommand(fixture, command);

    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(label), 'info');
    expect(fixture.notify.mock.calls[0]?.[0]).not.toContain('declares');
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`names the declared language when a project has no ${label} guide`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    const declared =
      languageCases.find((candidate) => candidate.language !== language) ?? languageCases[0];

    await writeStommeProject(fixture.directory, {
      language: declared?.language ?? language,
    });

    await fixture.prompt();
    await runLanguageCommand(fixture, command);

    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(declared?.label ?? label),
      'warning',
    );

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`warns that a session without the coding set has no ${label} guide in a project`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished, {
      usesCodingSet: () => Promise.resolve(false),
    });

    await writeStommeProject(fixture.directory, { language });
    await fixture.prompt();
    await runLanguageCommand(fixture, command);

    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(label),
      'warning',
    );

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`warns that ${label} rules are off when the project guides are broken`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await writeStommeProject(fixture.directory, { language });
    await rm(join(fixture.directory, 'docs', 'stomme', '.sync-record.toml'));
    await fixture.prompt();
    await runLanguageCommand(fixture, command);

    const warnings = fixture.notify.mock.calls.filter(([, level]) => level === 'warning');

    expect(warnings).toEqual([[expect.stringContaining(label), 'warning']]);
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`describes the ${label} command by its language`, async ({ onTestFinished }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    expect(fixture.api.commands.get(command)?.description).toContain(label);
  });

  it(`leaves ${label} rules off when an idle command finds a project that appeared`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.prompt();
    await writeStommeProject(fixture.directory, { language });
    fixture.idle.mockReturnValue(true);
    await runLanguageCommand(fixture, command);

    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'info');

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`keeps the run's bundle snapshot for a busy ${label} command`, async ({ onTestFinished }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.prompt();
    await writeStommeProject(fixture.directory, { language });
    fixture.idle.mockReturnValue(false);
    await runLanguageCommand(fixture, command);

    expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, {
      version: 1,
    });

    expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(delivered(customType, rules), {
      deliverAs: 'steer',
    });
  });
}
