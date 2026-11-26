import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSweep } from '../src/improvement/sweep.ts';
import type { SweepOptions, SweepOutcome } from '../src/improvement/sweep.ts';
import { readSweepIndex } from '../src/improvement/sweepIndex.ts';
import type { SweepIndex } from '../src/improvement/sweepIndex.ts';
import { createExecFake, succeededResult } from './execFake.ts';
import type { ExecFake, ExecHandler, ExecResult } from './execFake.ts';
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

interface MergedGate {
  // Resolves when the sweep asks for the merged list.
  reached: Promise<undefined>;
}

export interface SweepFixture {
  agentDirectory: string;
  repository: string;
  fake: ExecFake<'merged'>;
  setMerged: (next: MergedListing[]) => void;
  gateMergedList: () => MergedGate;
  setNow: (date: Date) => void;
  advance: (milliseconds: number) => void;
  writeSession: (name: string, content: string) => string;
  writeFixtureSession: (name: string, fixtureName: string) => string;
  run: (options?: Partial<SweepOptions>) => Promise<SweepOutcome>;
  readIndex: () => Promise<SweepIndex>;
  eventFiles: () => string[];
}

export class MissingMergedListSignalError extends Error {
  constructor() {
    super('The sweep passed no signal to the merged list.');
    this.name = 'MissingMergedListSignalError';
  }
}

export class MergedListAbortError extends Error {
  constructor() {
    super('Sweep aborted.');
    this.name = 'MergedListAbortError';
  }
}

const fixturePath = (name: string) =>
  join(import.meta.dirname, '..', 'src', 'improvement', 'fixtures', name);

const sessionRecord = /("type":"session"[^\n]*?"cwd":)"[^"]*"/u;

// A fixture session names the developer's home, so its paths move under the fixture home. The
// session cwd must name the repository after that rewrite, not before.
export const rewriteFixtureSession = (
  content: string,
  repository: string,
  fixtureHome: string,
): string => {
  const rewritten = content.replaceAll('/home/', `${fixtureHome}/`);
  const cwd = JSON.stringify(repository);

  return rewritten.replace(sessionRecord, (_record, prefix: string) => `${prefix}${cwd}`);
};

export const eventHash = (repository: string, number: number): string =>
  createHash('sha256').update(`${repository}#${number}`).digest('hex').slice(0, 32);

export const createSweepFixture = async (
  onTestFinished: RegisterCleanup,
): Promise<SweepFixture> => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-');
  const repository = await createTemporaryRepository(onTestFinished);

  await git(repository, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');

  let listings: MergedListing[] = [];
  let mergedHandler: ExecHandler | undefined;
  let current = new Date('2026-11-15T12:00:00.000Z');

  const fake = createExecFake<'merged'>({
    keyOf: (command, commandArguments) =>
      command === 'gh' && commandArguments[0] === 'pr' && commandArguments[1] === 'list'
        ? 'merged'
        : undefined,
    handlerFor: () => mergedHandler ?? (() => succeededResult(JSON.stringify(listings))),
  });

  const gateMergedList = (): MergedGate => {
    const reached = Promise.withResolvers<undefined>();

    mergedHandler = (_commandArguments, options): Promise<ExecResult> => {
      reached.resolve(undefined);

      const signal = options?.signal;

      if (signal === undefined) {
        throw new MissingMergedListSignalError();
      }

      const abortReason = (): Error =>
        signal.reason instanceof Error ? signal.reason : new MergedListAbortError();

      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(abortReason());

          return;
        }

        signal.addEventListener(
          'abort',
          () => {
            reject(abortReason());
          },
          { once: true },
        );
      });
    };

    return { reached: reached.promise };
  };

  const writeSession = (name: string, content: string): string => {
    const path = join(agentDirectory, 'sessions', name);

    mkdirSync(join(agentDirectory, 'sessions'), { recursive: true });
    writeFileSync(path, content);

    return path;
  };

  const writeFixtureSession = (name: string, fixtureName: string): string => {
    const content = readFileSync(fixturePath(fixtureName), 'utf8');
    const fixtureHome = join(agentDirectory, 'fixture-home');
    const rewritten = rewriteFixtureSession(content, repository, fixtureHome);

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
    gateMergedList,
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
