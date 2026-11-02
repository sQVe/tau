import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import {
  allowModels,
  answered,
  classifierId,
  classifierProvider,
  haiku,
  resolveRoutedLoadout,
  routedFixture,
} from './fixtures/routedLoadout.js';

it('looks up the route classifier and sends the brief to it', async ({ onTestFinished }) => {
  const { context, classify, findOfType } = await routedFixture(onTestFinished);
  classify.mockResolvedValue(answered('narrow', 0.9));

  await resolveRoutedLoadout({ profile: 'scout', task: 'Find the parser.' }, context);

  expect(findOfType).toHaveBeenCalledWith('classifier', classifierProvider, classifierId);
  expect(classify).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(classify.mock.calls[0])).toContain('Find the parser.');
});

it('skips classification when the classifier is outside allowedModels', async ({
  onTestFinished,
}) => {
  const { directory, context, classify, findOfType, profileModel } =
    await routedFixture(onTestFinished);

  const configPath = join(directory, 'tau.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as object;

  writeFileSync(configPath, JSON.stringify({ ...config, allowedModels: [profileModel, haiku] }));

  const { loadout } = await resolveRoutedLoadout(
    { profile: 'scout', task: 'Find the parser.' },
    context,
  );

  expect(loadout.model).toBe(profileModel);
  expect(classify).not.toHaveBeenCalled();
  expect(findOfType).not.toHaveBeenCalled();
});

it.for([
  ['an error result', () => Promise.resolve({ stopReason: 'error', answers: {} })],
  ['a rejection', () => Promise.reject(new Error('offline'))],
] as const)('launches on the profile model after %s', async ([, outcome], { onTestFinished }) => {
  const { context, classify, profileModel } = await routedFixture(onTestFinished);
  classify.mockImplementation(outcome);

  const { loadout, routing } = await resolveRoutedLoadout(
    { profile: 'worker', task: 'Fix it.', acceptance: ['It is fixed.'] },
    context,
  );

  expect(loadout.model).toBe(profileModel);

  expect(routing).toEqual({
    shadowPick: profileModel,
    fallbackReason: 'error',
    confidenceCutoff: 0.7,
    ticketSent: false,
  });
});

it('launches on the profile model when the classifier never answers within 5 seconds', async ({
  onTestFinished,
}) => {
  const { context, classify, profileModel } = await routedFixture(onTestFinished);
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });

  classify.mockImplementation(() => new Promise(() => {}));

  const pending = resolveRoutedLoadout({ profile: 'scout', task: 'Find it.' }, context);
  const settled = vi.fn<() => void>();
  const finished = pending.then(settled);

  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await finished;
  const { loadout, routing } = await pending;

  expect(loadout.model).toBe(profileModel);

  expect(routing).toEqual({
    shadowPick: profileModel,
    fallbackReason: 'timeout',
    confidenceCutoff: 0.7,
    ticketSent: false,
  });

  const options = classify.mock.calls[0]?.[2] as { signal: AbortSignal };
  expect(options.signal.aborted).toBe(true);
});

it('stops a pending classification when the launch is cancelled', async ({ onTestFinished }) => {
  const { context, classify } = await routedFixture(onTestFinished);
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });

  classify.mockImplementation(() => new Promise(() => {}));
  const launch = new AbortController();

  const pending = resolveRoutedLoadout(
    { profile: 'scout', task: 'Find it.' },
    context,
    [],
    launch.signal,
  );

  const settled = vi.fn<() => void>();
  const finished = pending.then(settled);

  launch.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toHaveBeenCalledOnce();
  await finished;

  const options = classify.mock.calls[0]?.[2] as { signal: AbortSignal };
  expect(options.signal.aborted).toBe(true);
});

const classifiedState = (classify: { mock: { calls: unknown[][] } }) => {
  const request = classify.mock.calls[0]?.[1] as { state: unknown };

  return request.state;
};

const saveTicket = (directory: string, text: string) => {
  mkdirSync(join(directory, '.tau', 'slices', 'ME-1'), { recursive: true });
  writeFileSync(join(directory, '.tau', 'slices', 'ME-1', 'agent-1.md'), text);
};

it('sends the ticket a relative path names and records that it was sent', async ({
  onTestFinished,
}) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  saveTicket(directory, 'Change the parser.');
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = 'Carry out the task in `.tau/slices/ME-1/agent-1.md`.';
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({
    brief,
    ticket: 'Change the parser.',
    profile: 'scout',
  });

  expect(routing).toEqual({
    shadowPick: haiku,
    label: 'narrow',
    confidence: 0.9,
    confidenceCutoff: 0.7,
    ticketSent: true,
  });
});

it('sends no file that a ticket path leaves the slices directory for', async ({
  onTestFinished,
}) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  writeFileSync(join(directory, 'notes.md'), 'Private notes.');
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = 'Carry out the task in .tau/slices/../../notes.md';
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({ brief, profile: 'scout' });
  expect(routing).toMatchObject({ ticketSent: false });
});

it('sends the ticket an absolute path names', async ({ onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  saveTicket(directory, 'Absolute ticket.');
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = `Read ${join(directory, '.tau', 'slices', 'ME-1', 'agent-1.md')} first.`;
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({
    brief,
    ticket: 'Absolute ticket.',
    profile: 'scout',
  });

  expect(routing?.ticketSent).toBe(true);
});

it('caps the ticket text at 12000 characters', async ({ onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  saveTicket(directory, `${'a'.repeat(11_999)}${'é'.repeat(50_000)}`);
  classify.mockResolvedValue(answered('narrow', 0.9));

  await resolveRoutedLoadout(
    { profile: 'scout', task: 'Task in .tau/slices/ME-1/agent-1.md' },
    context,
  );

  const { ticket } = classifiedState(classify) as { ticket: string };
  expect(ticket).toBe(`${'a'.repeat(11_999)}é`);
});

it('sends the whole ticket when the file returns short reads', async ({ onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  saveTicket(directory, 'a'.repeat(5000));
  classify.mockResolvedValue(answered('narrow', 0.9));

  const probe = await open(join(directory, '.tau', 'slices', 'ME-1', 'agent-1.md'));
  const fileHandle = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();

  type PositionalRead = (
    this: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => ReturnType<FileHandle['read']>;

  const read = fileHandle.read as PositionalRead;

  const returnShortRead: PositionalRead = function (buffer, offset, length, position) {
    return read.call(this, buffer, offset, Math.min(length, 1000), position);
  };

  const shortRead = vi
    .spyOn(fileHandle, 'read')
    .mockImplementation(returnShortRead as FileHandle['read']);

  onTestFinished(() => {
    shortRead.mockRestore();
  });

  await resolveRoutedLoadout(
    { profile: 'scout', task: 'Task in .tau/slices/ME-1/agent-1.md' },
    context,
  );

  const { ticket } = classifiedState(classify) as { ticket: string };
  expect(ticket).toBe('a'.repeat(5000));
});

it.for<[string, string]>([
  ['a missing file', 'Task in .tau/slices/ME-1/missing.md'],
  ['a directory', 'Task in .tau/slices/ME-1/folder.md'],
  ['no path', 'Find the parser.'],
])('classifies on the brief alone for %s', async ([, brief], { onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  mkdirSync(join(directory, '.tau', 'slices', 'ME-1', 'folder.md'), { recursive: true });
  classify.mockResolvedValue(answered('narrow', 0.9));

  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({ brief, profile: 'scout' });
  expect(routing?.ticketSent).toBe(false);
});

it('records the ticket as sent when the classifier then times out', async ({ onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  saveTicket(directory, 'Slow.');
  classify.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const pending = resolveRoutedLoadout(
    { profile: 'scout', task: 'Task in .tau/slices/ME-1/agent-1.md' },
    context,
  );

  await vi.waitFor(() => {
    expect(classify).toHaveBeenCalled();
  });

  await vi.advanceTimersByTimeAsync(5000);
  const { routing } = await pending;

  expect(routing).toMatchObject({ fallbackReason: 'timeout', ticketSent: true });
});

it('cancels the classification when the launch aborts during the ticket read', async ({
  onTestFinished,
}) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  saveTicket(directory, 'Aborted.');
  const launch = new AbortController();

  const pending = resolveRoutedLoadout(
    { profile: 'scout', task: 'Task in .tau/slices/ME-1/agent-1.md' },
    context,
    [],
    launch.signal,
  );

  launch.abort();
  const { routing } = await pending;

  expect(routing).toMatchObject({ fallbackReason: 'error', ticketSent: false });
  expect(classify).not.toHaveBeenCalled();
});

it('classifies nothing when allowedModels excludes the classifier', async ({ onTestFinished }) => {
  const { directory, context, classify, profileModel } = await routedFixture(onTestFinished);
  const configPath = join(directory, 'tau.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  writeFileSync(configPath, JSON.stringify({ ...config, allowedModels: [profileModel, haiku] }));
  classify.mockResolvedValue(answered('narrow', 0.9));

  const { loadout, routing } = await resolveRoutedLoadout(
    { profile: 'scout', task: 'Find it.' },
    context,
  );

  expect(loadout.model).toBe(profileModel);

  expect(routing).toEqual({
    shadowPick: profileModel,
    fallbackReason: 'noRoute',
    confidenceCutoff: 0.7,
    ticketSent: false,
  });

  expect(classify).not.toHaveBeenCalled();
});

it('classifies nothing when the repository allowedModels excludes the classifier', async ({
  onTestFinished,
}) => {
  const { directory, context, classify, profileModel } = await routedFixture(onTestFinished);

  allowModels(join(directory, '.pi', 'tau.json'), [profileModel, haiku]);
  classify.mockResolvedValue(answered('narrow', 0.9));

  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: 'Find it.' }, context);

  expect(routing).toMatchObject({ fallbackReason: 'noRoute' });
  expect(classify).not.toHaveBeenCalled();
});

const countHandlesTo = (target: string) =>
  readdirSync('/proc/self/fd').filter((descriptor) => {
    try {
      return readlinkSync(`/proc/self/fd/${descriptor}`) === target;
    } catch {
      return false;
    }
  }).length;

const linkTicket = (directory: string, target: string) => {
  mkdirSync(join(directory, '.tau', 'slices', 'ME-1'), { recursive: true });
  symlinkSync(target, join(directory, '.tau', 'slices', 'ME-1', 'agent-1.md'));
};

it('sends no text from a special file that a ticket path names', async ({ onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);

  linkTicket(directory, '/dev/zero');
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = 'Task in .tau/slices/ME-1/agent-1.md';
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({ brief, profile: 'scout' });
  expect(routing?.ticketSent).toBe(false);
});

it('sends no text from an outside file that a ticket symlink names', async ({ onTestFinished }) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  writeFileSync(join(directory, 'notes.md'), 'Private notes.');
  linkTicket(directory, join(directory, 'notes.md'));
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = 'Carry out the task in .tau/slices/ME-1/agent-1.md';
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({ brief, profile: 'scout' });
  expect(routing?.ticketSent).toBe(false);
});

it('sends no text from a ticket whose directory links outside the slices directory', async ({
  onTestFinished,
}) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'agent-1.md'), 'Private notes.');
  mkdirSync(join(directory, '.tau', 'slices'), { recursive: true });
  symlinkSync(outside, join(directory, '.tau', 'slices', 'ME-1'));
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = 'Carry out the task in .tau/slices/ME-1/agent-1.md';
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({ brief, profile: 'scout' });
  expect(routing?.ticketSent).toBe(false);
});

it('sends no text from a nested slices directory that links outside', async ({
  onTestFinished,
}) => {
  const { context, classify, directory } = await routedFixture(onTestFinished);
  const outside = join(directory, 'outside');
  const nested = join(directory, '.tau', 'slices', 'ME-1', '.tau');
  mkdirSync(outside);
  writeFileSync(join(outside, 'agent-1.md'), 'Private notes.');
  mkdirSync(nested, { recursive: true });
  symlinkSync(outside, join(nested, 'slices'));
  classify.mockResolvedValue(answered('narrow', 0.9));

  const brief = 'Carry out the task in .tau/slices/ME-1/.tau/slices/agent-1.md';
  const { routing } = await resolveRoutedLoadout({ profile: 'scout', task: brief }, context);

  expect(classifiedState(classify)).toEqual({ brief, profile: 'scout' });
  expect(routing?.ticketSent).toBe(false);
});

const hasProcessDescriptors = existsSync('/proc/self/fd');

it.skipIf(!hasProcessDescriptors).for([
  ['a ticket file', true],
  ['a special file', false],
] as const)(
  'leaves no handle open for %s after reading it',
  async ([, regular], { onTestFinished }) => {
    const { context, classify, directory } = await routedFixture(onTestFinished);

    const target = regular ? join(directory, '.tau', 'slices', 'ME-1', 'agent-1.md') : '/dev/zero';

    if (regular) {
      saveTicket(directory, 'Close me.');
    } else {
      linkTicket(directory, target);
    }

    classify.mockResolvedValue(answered('narrow', 0.9));

    await resolveRoutedLoadout(
      { profile: 'scout', task: 'Task in .tau/slices/ME-1/agent-1.md' },
      context,
    );

    expect(countHandlesTo(realpathSync(target))).toBe(0);
  },
);
