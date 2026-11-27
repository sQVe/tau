import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { link, mkdir, readdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { installCommandShim, logCommandCalls } from '../../../tests/commandShimFake.js';
import { argumentAfter } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryBareRoot,
  createTemporaryRepository,
  git,
} from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { createHerdrAppFake, spaceOrTabLaunchesOf } from '../../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../../tests/herdrAppFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { readbackCall } from '../../../tests/piStartRequests.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { readHandoverText } from './handoverFile.js';
import { createHandoverTool } from './tool.js';

const runtimeOf = (fake: HcFake) => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const createTool = () => createHandoverTool(runtimeOf(createHcFake()));

afterEach(() => {
  vi.unstubAllEnvs();
});

const prepare = async (root: string) => {
  const result = await createTool().execute(
    'call',
    { action: 'prepare' },
    undefined,
    undefined,
    noUiContext(root),
  );

  return result.details as { directory: string };
};

const repositories = [
  { kind: 'worktree', create: createTemporaryRepository },
  { kind: 'bare root', create: createTemporaryBareRoot },
];

it.each(repositories)('prepares and reuses handovers in a $kind', async ({ create }) => {
  const root = await create(onTestFinished);

  const prepared = await prepare(root);

  expect(prepared.directory).toBe(join(root, '.tau', 'handovers'));
  expect((await stat(prepared.directory)).isDirectory()).toBe(true);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toMatch(/\*\n$/);
  expect(await prepare(root)).toEqual(prepared);
});

it('prepares at the checkout root from a nested directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const nested = join(root, 'nested');

  await mkdir(nested);

  expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
});

it('prepares at the bare root from a nested directory', async () => {
  const root = await createTemporaryBareRoot(onTestFinished);
  const nested = join(root, 'nested');

  await mkdir(nested);

  expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
});

it.each(['missing', 'directory', 'malformed', 'different target', 'missing target'])(
  'prepares in a plain bare Git directory when the parent .git is %s',
  async (kind) => {
    const container = await createTemporaryBareRoot(onTestFinished);
    const gitFile = join(container, '.git');
    const root = join(container, 'plain.git');
    const nested = join(root, 'nested');

    await git(container, 'init', '--bare', root);
    await unlink(gitFile);

    if (kind === 'directory') {
      await mkdir(gitFile);
    }

    if (kind === 'malformed') {
      await writeFile(gitFile, 'not a Git directory pointer\n');
    }

    if (kind === 'different target') {
      await writeFile(gitFile, 'gitdir: .bare\n');
    }

    if (kind === 'missing target') {
      await writeFile(gitFile, 'gitdir: absent\n');
    }

    await mkdir(nested);

    expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
    expect(await readdir(nested)).toEqual([]);
  },
);

it('matches the bare root Git file through a symlink target', async () => {
  const root = await createTemporaryBareRoot(onTestFinished);
  const nested = join(root, 'nested');

  await symlink(join(root, '.bare'), join(root, 'git-alias'));
  await writeFile(join(root, '.git'), 'gitdir: git-alias\n');
  await mkdir(nested);

  expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
});

it.each(repositories)('refuses symlinks in a $kind without outside writes', async ({ create }) => {
  const root = await create(onTestFinished);
  const outside = await createTemporaryRepository(onTestFinished);

  await symlink(outside, join(root, '.tau'));
  const before = await readdir(outside);

  await expect(prepare(root)).rejects.toThrow(/symlink/);

  expect(await readdir(outside)).toEqual(before);
});

it.each(repositories)(
  'refuses a hard-linked ignore file in a $kind without changing outside bytes',
  async ({ create }) => {
    const root = await create(onTestFinished);
    const outside = await createTemporaryRepository(onTestFinished);
    const outsideFile = join(outside, 'ignore');

    await writeFile(outsideFile, 'outside bytes\n');
    await mkdir(join(root, '.tau'));
    await link(outsideFile, join(root, '.tau', '.gitignore'));

    await expect(prepare(root)).rejects.toThrow(/hard link/);

    expect(await readFile(outsideFile, 'utf8')).toBe('outside bytes\n');
    expect(await readdir(join(root, '.tau'))).toEqual(['.gitignore']);
  },
);

it('refuses a tracked destination without changing it', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = join(root, '.tau', 'handovers');
  const message = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(message, 'tracked message\n');
  await git(root, 'add', '--force', message);

  await expect(prepare(root)).rejects.toThrow(/Git tracks files in .tau\/handovers/);

  expect(await readFile(message, 'utf8')).toBe('tracked message\n');
  expect(await readdir(join(root, '.tau'))).toEqual(['handovers']);
});

it('overrides a later ignore exception in a worktree', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const ignoreFile = join(root, '.tau', '.gitignore');

  await mkdir(join(root, '.tau'));
  await writeFile(ignoreFile, '*\n!handovers/\n!handovers/message.md\n');

  await prepare(root);

  expect(await readFile(ignoreFile, 'utf8')).toMatch(/\*\n$/);

  expect(await git(root, 'check-ignore', '--', '.tau/handovers/message.md')).toBe(
    '.tau/handovers/message.md',
  );
});

it('refuses a later ignore exception in a bare root without changing it', async () => {
  const root = await createTemporaryBareRoot(onTestFinished);
  const ignoreFile = join(root, '.tau', '.gitignore');
  const content = '*\n!handovers/message.md\n';

  await mkdir(join(root, '.tau'));
  await writeFile(ignoreFile, content);

  await expect(prepare(root)).rejects.toThrow(/exception follows/);

  expect(await readFile(ignoreFile, 'utf8')).toBe(content);
  expect(await readdir(join(root, '.tau'))).toEqual(['.gitignore']);
});

it('accepts prepare and rejects an unknown or missing action in the parameters Pi validates', () => {
  const { parameters } = createTool();

  expect(Value.Check(parameters, { action: 'prepare' })).toBe(true);
  expect(Value.Check(parameters, { action: 'delete' })).toBe(false);
  expect(Value.Check(parameters, {})).toBe(false);
});

it('gives the model the directory as JSON text in the tool content', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const result = await createTool().execute(
    'call',
    { action: 'prepare' },
    undefined,
    undefined,
    noUiContext(root),
  );

  const [block] = result.content;

  expect(block?.type).toBe('text');

  const textContent = block?.type === 'text' ? block.text : '';

  expect(JSON.parse(textContent)).toEqual({
    directory: join(root, '.tau', 'handovers'),
  });
});

it('accepts the send action with its terminal, file, and retry ID in the parameters Pi validates', () => {
  const { parameters } = createTool();
  const messageId = '11111111-1111-4111-8111-111111111111';

  expect(Value.Check(parameters, { action: 'send', terminal: 't7', file: 'message.md' })).toBe(
    true,
  );

  expect(
    Value.Check(parameters, {
      action: 'send',
      terminal: 't7',
      file: 'm.md',
      messageId,
      sessionId: '22222222-2222-4222-8222-222222222222',
    }),
  ).toBe(true);
});

it('sends the handover file to the receiver inbox and returns queued as JSON text', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const file = join(root, '.tau', 'handovers', 'message.md');
  const sockets = mkdtempSync('/tmp/tau-tool-');
  const messageId = '11111111-1111-4111-8111-111111111111';

  chmodSync(sockets, 0o700);

  onTestFinished(() => {
    rmSync(sockets, { recursive: true, force: true });
  });

  const receiver = await startHandoverReceiver(onTestFinished, sockets, 't7');

  vi.stubEnv('HC_TERMINAL_ID', 'caller');
  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  await writeFile(file, 'Next steps\n');

  fake.reply(
    'get',
    JSON.stringify({
      address: 't7',
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${receiver.path}` },
    }),
  );

  const result = await createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', file, messageId, sessionId: receiver.sessionId },
    undefined,
    undefined,
    noUiContext(root),
  );

  const queued = { status: 'queued', terminal: 't7', sessionId: receiver.sessionId, messageId };

  expect(result.details).toEqual(queued);

  const textContent = result.content[0]?.type === 'text' ? result.content[0].text : '';
  expect(JSON.parse(textContent)).toEqual(queued);
});

it('sends a handover with final true and returns queued', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const file = join(root, '.tau', 'handovers', 'message.md');
  const sockets = mkdtempSync('/tmp/tau-tool-');
  const messageId = '11111111-1111-4111-8111-111111111111';

  chmodSync(sockets, 0o700);

  onTestFinished(() => {
    rmSync(sockets, { recursive: true, force: true });
  });

  const receiver = await startHandoverReceiver(onTestFinished, sockets, 't7');

  vi.stubEnv('HC_TERMINAL_ID', 'caller');
  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  await writeFile(file, 'Next steps\n');

  fake.reply(
    'get',
    JSON.stringify({
      address: 't7',
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${receiver.path}` },
    }),
  );

  const result = await createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', file, messageId, sessionId: receiver.sessionId, final: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  const queued = { status: 'queued', terminal: 't7', sessionId: receiver.sessionId, messageId };

  expect(result.details).toEqual(queued);
});

it.each([
  ['an architect session sends no sender', 'architect', undefined],
  [
    'a lead session sends its terminal and session',
    undefined,
    { terminal: 'lead-terminal', sessionId: 'lead-session' },
  ],
] as const)('%s', async (_name, role, sender) => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const file = join(root, '.tau', 'handovers', 'message.md');
  const sockets = mkdtempSync('/tmp/tau-tool-');
  const messageId = '11111111-1111-4111-8111-111111111111';

  chmodSync(sockets, 0o700);

  onTestFinished(() => {
    rmSync(sockets, { recursive: true, force: true });
  });

  const receiver = await startHandoverReceiver(onTestFinished, sockets, 't7');

  vi.stubEnv('HC_TERMINAL_ID', 'lead-terminal');
  vi.stubEnv('TAU_ROLE', role);
  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  await writeFile(file, 'Next steps\n');

  fake.reply(
    'get',
    JSON.stringify({
      address: 't7',
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${receiver.path}` },
    }),
  );

  await createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', file, messageId, sessionId: receiver.sessionId },
    undefined,
    undefined,
    noUiContext(root, 'lead-session'),
  );

  const saved = JSON.parse(
    readFileSync(join(receiver.inbox, `${messageId}.json`), 'utf8'),
  ) as unknown;

  expect(saved).toEqual({
    version: 4,
    messageId,
    family: 'handover',
    payload: { text: 'Next steps\n', ...(sender === undefined ? {} : { sender }) },
  });
});

it('sends no sender when the session ID is empty', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const file = join(root, '.tau', 'handovers', 'message.md');
  const sockets = mkdtempSync('/tmp/tau-tool-');
  const messageId = '11111111-1111-4111-8111-111111111111';

  chmodSync(sockets, 0o700);

  onTestFinished(() => {
    rmSync(sockets, { recursive: true, force: true });
  });

  const receiver = await startHandoverReceiver(onTestFinished, sockets, 't7');

  vi.stubEnv('HC_TERMINAL_ID', 'lead-terminal');
  vi.stubEnv('TAU_ROLE', 'lead');
  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  await writeFile(file, 'Next steps\n');

  fake.reply(
    'get',
    JSON.stringify({
      address: 't7',
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${receiver.path}` },
    }),
  );

  await createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', file, messageId, sessionId: receiver.sessionId },
    undefined,
    undefined,
    noUiContext(root, ''),
  );

  const saved = JSON.parse(
    readFileSync(join(receiver.inbox, `${messageId}.json`), 'utf8'),
  ) as unknown;

  expect(saved).toEqual({
    version: 4,
    messageId,
    family: 'handover',
    payload: { text: 'Next steps\n' },
  });
});

it('refuses a send without a terminal before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();

  const execution = createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', file: join(root, 'message.md') },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(/send needs a terminal/);

  expect(fake.calls).toEqual([]);
});

it('refuses a retry without the session of the unknown result before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();

  const execution = createHandoverTool(runtimeOf(fake)).execute(
    'call',
    {
      action: 'send',
      terminal: 't7',
      file: join(root, 'message.md'),
      messageId: '11111111-1111-4111-8111-111111111111',
    },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(/send retry needs the sessionId/);

  expect(fake.calls).toEqual([]);
});

const writeHandover = async (root: string, content: string): Promise<string> => {
  const directory = join(root, '.tau', 'handovers');
  const file = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(file, content);

  return file;
};

const createStartTool = (app: ExecFake<HerdrAppCommand>) =>
  createHandoverTool({ exec: app.exec, connect: createHcFake().connect, cwd: '/repository' });

const modelContext = (
  root: string,
  registerCleanup: (cleanup: () => void) => void,
): ExtensionToolContext => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(registerCleanup, 'tau-handover-agent-'));

  return {
    ...noUiContext(root),
    isProjectTrusted: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
    },
  } as unknown as ExtensionToolContext;
};

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();

  controller.abort();

  return controller.signal;
};

it('refuses an already-aborted send before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const file = await writeHandover(root, 'Next steps\n');

  const execution = createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', file },
    abortedSignal(),
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toMatchObject({ name: 'AbortError' });

  expect(fake.calls).toEqual([]);
});

it('starts an architect tab without a sender', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('HC_TERMINAL_ID', 'architect-terminal');

  await createStartTool(app).execute(
    'call',
    { action: 'start', file, folder: root, space: 'space-1', name: 'Next steps' },
    undefined,
    undefined,
    noUiContext(root, 'architect-session'),
  );

  const [launch] = app.calls;

  expect(argumentAfter(launch?.commandArguments ?? [], '--argv')).toBe('["pi"]');
  expect(argumentAfter(launch?.commandArguments ?? [], '--task')).toBe('Next steps\n');
});

it('starts a tab from a real bare repository root', async () => {
  const root = await createTemporaryBareRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  const result = await createStartTool(app).execute(
    'call',
    { action: 'start', file, folder: root, space: 'space-1', name: 'Next steps' },
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    space: 'space-1',
    tab: 'tb-new',
    terminal: 't-new',
    model: 'default',
    spaceStatus: 'reused',
  });

  const launchCommands = spaceOrTabLaunchesOf(app).map((call) => call.commandArguments[1]);

  expect(launchCommands).toEqual(['tab.new']);
});

const countBareProbes = (calls: string): number =>
  calls.split('\n').filter((call) => call === 'rev-parse --is-bare-repository').length;

it('starts from a repository with a .git entry without asking Git whether it is bare', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();
  const logPath = join(temporaryDirectory(onTestFinished, 'tau-handover-git-calls-'), 'calls.log');

  await writeFile(logPath, '');
  await installCommandShim('git', { otherCalls: 'real', overrides: [logCommandCalls(logPath)] });

  await readHandoverText(root, file);
  const readingProbes = countBareProbes(await readFile(logPath, 'utf8'));

  await writeFile(logPath, '');

  await createStartTool(app).execute(
    'call',
    { action: 'start', file, folder: root, space: 'space-1', name: 'Next steps' },
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(countBareProbes(await readFile(logPath, 'utf8'))).toBe(readingProbes);
});

it('passes the model to the new Pi through herdr-app', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  await createStartTool(app).execute(
    'call',
    {
      action: 'start',
      file,
      folder: root,
      space: 'space-1',
      name: 'Next steps',
      model: 'morph/morph-dsv41flash-1017',
    },
    undefined,
    undefined,
    modelContext(root, onTestFinished),
  );

  const [launch] = app.calls;

  expect(argumentAfter(launch?.commandArguments ?? [], '--argv')).toBe(
    '["pi","--provider","morph","--model","morph-dsv41flash-1017"]',
  );

  expect(app.calls).toContainEqual(readbackCall('t-new'));
});

it('refuses a regular file as the start folder before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const folder = join(root, 'folder-file');
  const app = createHerdrAppFake();

  await writeFile(folder, 'not a directory\n');

  const execution = createStartTool(app).execute(
    'call',
    { action: 'start', file, folder, space: 'space-1', name: 'Next steps' },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(app.calls).toEqual([]);
});

it('refuses a start without a name before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();
  const tool = createStartTool(app);
  const context = noUiContext(root);

  const missingName = await tool
    .execute(
      'call',
      { action: 'start', file, folder: root, space: 'space-1' },
      undefined,
      undefined,
      context,
    )
    .catch((error: unknown) => error);

  expect(missingName).toBeInstanceOf(Error);
  expect(missingName).not.toBeInstanceOf(TypeError);

  await expect(
    tool.execute(
      'call',
      { action: 'start', file, folder: root, space: 'space-1', name: '   ' },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toBeInstanceOf(Error);

  await expect(
    tool.execute('call', { action: 'start', file, folder: root }, undefined, undefined, context),
  ).rejects.toBeInstanceOf(Error);

  expect(app.calls).toEqual([]);
});

it.each([
  { folder: '', name: 'an empty folder' },
  { folder: '../target', name: 'a relative folder' },
])('refuses a start with $name before any herdr-app call', async ({ folder }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  const execution = createStartTool(app).execute(
    'call',
    { action: 'start', file, folder, name: 'me-1' },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(/start needs an absolute folder/);

  expect(app.calls).toEqual([]);
});

it('refuses a malformed start model before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  const execution = createStartTool(app).execute(
    'call',
    {
      action: 'start',
      file,
      folder: root,
      space: 'space-1',
      name: 'Next steps',
      model: 'no-slash',
    },
    undefined,
    undefined,
    modelContext(root, onTestFinished),
  );

  await expect(execution).rejects.toThrow(/Invalid model "no-slash"/);

  expect(app.calls).toEqual([]);
});

it('refuses a start model outside allowedModels before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  await mkdir(join(root, '.pi'), { recursive: true });

  await writeFile(
    join(root, '.pi', 'tau.json'),
    JSON.stringify({ allowedModels: ['other/model'] }),
  );

  const execution = createStartTool(app).execute(
    'call',
    {
      action: 'start',
      file,
      folder: root,
      space: 'space-1',
      name: 'Next steps',
      model: 'morph/morph-dsv41flash-1017',
    },
    undefined,
    undefined,
    modelContext(root, onTestFinished),
  );

  await expect(execution).rejects.toThrow(/morph\/morph-dsv41flash-1017 is not allowed/);

  expect(app.calls).toEqual([]);
});

it('refuses a model with prepare and creates no directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const execution = createTool().execute(
    'call',
    { action: 'prepare', model: 'morph/morph-dsv41flash-1017' },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('model is only for action start.');

  expect(existsSync(join(root, '.tau'))).toBe(false);
});

it('refuses a model with send before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();

  const execution = createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', file: join(root, 'message.md'), model: 'a/b' },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('model is only for action start.');

  expect(fake.calls).toEqual([]);
});

it('refuses final outside send', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const execution = createTool().execute(
    'call',
    { action: 'prepare', final: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('final is only for action send.');

  expect(existsSync(join(root, '.tau'))).toBe(false);
});

it('refuses space with prepare and creates no directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const execution = createTool().execute(
    'call',
    { action: 'prepare', space: 'space-1' },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('space is only for action start.');

  expect(existsSync(join(root, '.tau'))).toBe(false);
});

it('refuses space with send before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();

  const execution = createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', space: 'space-1' },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('space is only for action start.');

  expect(fake.calls).toEqual([]);
});

it('refuses newSpace with prepare and creates no directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const execution = createTool().execute(
    'call',
    { action: 'prepare', newSpace: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('newSpace is only for action start.');

  expect(existsSync(join(root, '.tau'))).toBe(false);
});

it('refuses newSpace with send before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();

  const execution = createHandoverTool(runtimeOf(fake)).execute(
    'call',
    { action: 'send', terminal: 't7', newSpace: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('newSpace is only for action start.');

  expect(fake.calls).toEqual([]);
});

it('refuses space together with newSpace before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  const execution = createStartTool(app).execute(
    'call',
    { action: 'start', file, folder: root, name: 'next step', space: 'space-1', newSpace: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(
    'space and newSpace cannot be used together: pass one of them.',
  );

  expect(app.calls).toEqual([]);
});

it('refuses an already-aborted start before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const app = createHerdrAppFake();

  const execution = createStartTool(app).execute(
    'call',
    { action: 'start', file, folder: root, space: 'space-1', name: 'Next steps' },
    abortedSignal(),
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toMatchObject({ name: 'AbortError' });

  expect(app.calls).toEqual([]);
});
