import { expect, it } from 'vitest';

import {
  commandArgumentsOf,
  createHerdrAppFake,
  spaceOrTabLaunchesOf,
  terminalFromReply,
} from './herdrAppFake.js';

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

it('fails a tab.new whose space value is another flag', async () => {
  await expect(replyTo(['tab.new', '--space', '--folder', '/work/repo'])).rejects.toThrow(
    'tab.new --space needs a value, got the flag --folder',
  );
});

it('answers space.new with a launch reply', async () => {
  const reply = await replyTo(['space.new', '--name', 'ticket-1', '--folder', '/work/repo']);

  expect(JSON.parse(reply)).toEqual({ space: 'sp-new', tab: 'tb-new', terminal: 't-new' });
});

it('lists the spaces it was given with no tabs', async () => {
  const fake = createHerdrAppFake({
    spaces: [{ id: 'sp-1', name: 'platform', folder: '/work/repo', machine: 'build-2' }],
  });

  const result = await fake.exec('herdr-app', ['ls'], undefined);

  expect(JSON.parse(result.stdout)).toEqual({
    spaces: [{ id: 'sp-1', name: 'platform', folder: '/work/repo', machine: 'build-2', tabs: [] }],
  });
});

it('counts a space launch and a tab launch and not a pane split', async () => {
  const fake = createHerdrAppFake();

  await fake.exec('herdr-app', ['do', 'pane.split', '--pane', 'p-1'], undefined);
  await fake.exec('herdr-app', ['do', 'space.new', '--name', 'ticket-1'], undefined);
  await fake.exec('herdr-app', ['do', 'tab.new', '--space', 'sp-1'], undefined);

  const launches = commandArgumentsOf(spaceOrTabLaunchesOf(fake));

  expect(launches).toEqual([
    ['do', 'space.new', '--name', 'ticket-1'],
    ['do', 'tab.new', '--space', 'sp-1'],
  ]);
});

it('fails a command it does not model instead of answering it', async () => {
  const fake = createHerdrAppFake();
  const result = await fake.exec('herdr-app', ['do', 'pane.swap', '--pane', 'p-1'], undefined);

  expect(result).toMatchObject({ code: 1, stdout: '' });
  expect(result.stderr).toContain('pane.swap');
});

it('reports a terminal it did not start as not_found', async () => {
  const fake = createHerdrAppFake();
  const result = await fake.exec('hc', ['get', '--json', '--', 't-missing'], undefined);

  expect(result.code).toBe(3);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { kind: 'not_found' } });
});

it('records no foreground for a reply that carried no --argv', async () => {
  const fake = createHerdrAppFake();

  const launched = await fake.exec('herdr-app', ['do', 'pane.split', '--pane', 'p-1'], undefined);
  const address = terminalFromReply(launched.stdout) ?? '';

  expect(address).toBe('t-new');

  const result = await fake.exec('hc', ['get', '--json', '--', address], undefined);

  expect(result.code).toBe(3);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { kind: 'not_found' } });
});

it('fails a malformed --argv instead of reporting no foreground', async () => {
  const fake = createHerdrAppFake();

  await expect(
    fake.exec('herdr-app', ['do', 'pane.split', '--pane', 'p-1', '--argv', 'not json'], undefined),
  ).rejects.toThrow('herdr-app fake received malformed --argv JSON: not json');
});

it.each(['{}', '7', '[1,2]'])(
  'fails a --argv that parses to %s instead of reporting no foreground',
  async (argv) => {
    const fake = createHerdrAppFake();

    await expect(
      fake.exec('herdr-app', ['do', 'pane.split', '--pane', 'p-1', '--argv', argv], undefined),
    ).rejects.toThrow(`herdr-app fake received a --argv that is not a list of strings: ${argv}`);
  },
);

it('reads the started folder from the argv env -C for a split', async () => {
  const fake = createHerdrAppFake();
  const argv = JSON.stringify(['env', '-C', '/work/repo', 'pi']);

  const launched = await fake.exec(
    'herdr-app',
    ['do', 'pane.split', '--pane', 'p-1', '--argv', argv],
    undefined,
  );

  const address = terminalFromReply(launched.stdout) ?? '';
  const result = await fake.exec('hc', ['get', '--json', '--', address], undefined);

  const reply = JSON.parse(result.stdout) as { foreground?: { cwd?: string } };

  expect(reply.foreground?.cwd).toBe('/work/repo');
});
