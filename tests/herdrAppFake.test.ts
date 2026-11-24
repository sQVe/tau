import { expect, it } from 'vitest';

import { createHerdrAppFake } from './herdrAppFake.js';

const replyTo = async (commandArguments: readonly string[]): Promise<string> => {
  const fake = createHerdrAppFake();
  const result = await fake.exec('herdr-app', ['do', ...commandArguments], undefined);

  return result.stdout;
};

it('answers tab.new with the space it was given', async () => {
  const reply = await replyTo(['tab.new', '--space', 'sp-9', '--folder', '/work/repo']);

  expect(JSON.parse(reply)).toEqual({ space: 'sp-9', tab: 'tb-new', terminal: 't-new' });
});

it('fails a tab.new without a space instead of inventing one', async () => {
  await expect(replyTo(['tab.new', '--folder', '/work/repo'])).rejects.toThrow(
    'tab.new needs --space',
  );
});

it('answers space.new with a launch reply', async () => {
  const reply = await replyTo(['space.new', '--name', 'ticket-1', '--folder', '/work/repo']);

  expect(JSON.parse(reply)).toEqual({ space: 'sp-new', tab: 'tb-new', terminal: 't-new' });
});

it('fails a command it does not model instead of answering it', async () => {
  const fake = createHerdrAppFake();
  const result = await fake.exec('herdr-app', ['do', 'pane.swap', '--pane', 'p-1'], undefined);

  expect(result).toMatchObject({ code: 1, stdout: '' });
  expect(result.stderr).toContain('pane.swap');
});
