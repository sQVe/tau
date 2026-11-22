import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSweep } from '../src/improvement/sweep.ts';
import type { SweepOptions, SweepOutcome } from '../src/improvement/sweep.ts';
import { readSweepIndex } from '../src/improvement/sweepIndex.ts';
import type { SweepIndex } from '../src/improvement/sweepIndex.ts';
import { createExecFake, succeededResult } from './execFake.ts';
import type { ExecFake } from './execFake.ts';
import { createTemporaryRepository, git } from './gitRepository.ts';
import { temporaryDirectory } from './temporaryDirectoryHarness.ts';

interface MergedListing {
  number: number;
  url: string;
  headRefName: string;
  createdAt: string;
  mergedAt: string;
}

type RegisterCleanup = (cleanup: () => void) => void;

export interface SweepFixture {
  agentDirectory: string;
  repository: string;
  fake: ExecFake<'merged'>;
  setMerged: (next: MergedListing[]) => void;
  setNow: (date: Date) => void;
  advance: (milliseconds: number) => void;
  writeSession: (name: string, content: string) => string;
  writeFixtureSession: (name: string, fixtureName: string) => string;
  run: (options?: Partial<SweepOptions>) => Promise<SweepOutcome>;
  readIndex: () => Promise<SweepIndex>;
  eventFiles: () => string[];
}

const fixturePath = (name: string) =>
  join(import.meta.dirname, '..', 'src', 'improvement', 'fixtures', name);

export const eventHash = (repository: string, number: number): string =>
  createHash('sha256').update(`${repository}#${number}`).digest('hex').slice(0, 32);

export const createSweepFixture = async (
  onTestFinished: RegisterCleanup,
): Promise<SweepFixture> => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-');
  const repository = await createTemporaryRepository(onTestFinished);

  await git(repository, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');

  let listings: MergedListing[] = [];
  let current = new Date('2026-11-15T12:00:00.000Z');

  const fake = createExecFake<'merged'>({
    keyOf: (command, commandArguments) =>
      command === 'gh' && commandArguments[0] === 'pr' && commandArguments[1] === 'list'
        ? 'merged'
        : undefined,
    handlerFor: () => () => succeededResult(JSON.stringify(listings)),
  });

  const writeSession = (name: string, content: string): string => {
    const path = join(agentDirectory, 'sessions', name);

    mkdirSync(join(agentDirectory, 'sessions'), { recursive: true });
    writeFileSync(path, content);

    return path;
  };

  const writeFixtureSession = (name: string, fixtureName: string): string => {
    const content = readFileSync(fixturePath(fixtureName), 'utf8');
    const fixtureHome = join(agentDirectory, 'fixture-home');

    const rewritten = content
      .replace(/"cwd":"[^"]*"/u, `"cwd":${JSON.stringify(repository)}`)
      .replaceAll('/home/', `${fixtureHome}/`);

    return writeSession(name, rewritten);
  };

  const run = (options: Partial<SweepOptions> = {}): Promise<SweepOutcome> =>
    runSweep({
      agentDirectory,
      cwd: repository,
      exec: fake.exec,
      now: () => current,
      budgetMilliseconds: 20_000,
      since: '2026-04-09',
      signal: new AbortController().signal,
      ...options,
    });

  const readIndex = async (): Promise<SweepIndex> => {
    const read = await readSweepIndex(agentDirectory);

    if (read.status !== 'read') {
      throw new Error(`The sweep index is ${read.status}.`);
    }

    return read.index;
  };

  const eventFiles = (): string[] => {
    try {
      return readdirSync(join(repository, '.tau', 'improvement'))
        .filter((name) => !name.startsWith('.'))
        .toSorted();
    } catch {
      return [];
    }
  };

  return {
    agentDirectory,
    repository,
    fake,
    setMerged: (next: MergedListing[]): void => {
      listings = next;
    },
    setNow: (date: Date): void => {
      current = date;
    },
    advance: (milliseconds: number): void => {
      current = new Date(current.getTime() + milliseconds);
    },
    writeSession,
    writeFixtureSession,
    run,
    readIndex,
    eventFiles,
  };
};
