import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { onTestFinished, vi } from 'vitest';

import { argumentAfter, failedResult, succeededResult } from '../../../../tests/execFake.js';
import type { ExecFake, ExecResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import {
  createHerdrAppFake,
  launchedTerminalReply,
  terminalFromReply,
} from '../../../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../../../tests/herdrAppFake.js';
import { replaceCurrentLockOwnerPid } from '../../../../tests/lockOwnerRecord.js';
import {
  fakeRunningStartProcessId,
  fakeStartProcessId,
  takeStartTicket,
  takingStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import type { FakeStartProcess } from '../../../../tests/startTicketFake.js';
import type { Exec } from '../../../command.js';
import { holdFileLock } from '../../../fileLock/fileLock.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { architectLockPath } from '../lock.js';
import type { OpenRequest } from '../open/open.js';
import { architectRecordPath, writeArchitectRecord, writeAskRecord } from '../record.js';
import { adoptStartMarker } from '../startTicket/startTicket.js';
import { createArchitectTool } from '../tool.js';
import { contextOf } from './toolHarness.js';

interface OpenTool {
  hc: HcFake;
  app: ExecFake<HerdrAppCommand>;
  terminals: Map<string, ExecResult>;
  tool: ReturnType<typeof createArchitectTool>;
  runtime: HcRuntime;
  // The fake child process, when the started terminal adopts the claim.
  processControl: FakeStartProcess | undefined;
}

interface OpenToolOptions {
  // A started Pi takes the lock over from the caller's claim. The takeover-expiry test turns it off.
  takeover?: boolean;
  afterTakeover?: () => void;
}

const appLayout = JSON.stringify({
  spaces: [
    {
      tabs: [
        {
          terminals: [
            { terminal: 't-lead', pane: 'p-lead' },
            { terminal: 't-architect', pane: 'p-shown' },
          ],
        },
      ],
    },
  ],
});

const appSplit = '{"pane":"p-architect","terminal":"t-architect"}';

const appFake = (): ExecFake<HerdrAppCommand> => {
  const app = createHerdrAppFake();

  app.overrideOutput('ls', appLayout);
  app.overrideOutput('pane.split', appSplit);
  app.overrideOutput('space.new', '{"space":"sp-1","tab":"tb-1","terminal":"t-architect"}');

  return app;
};

const leadTerminal = 't-lead';

const recordStartedTerminal = (
  terminals: Map<string, ExecResult>,
  commandArguments: readonly string[],
  reply: string,
): string | undefined => {
  const terminal = terminalFromReply(reply);

  if (terminal === undefined) {
    return undefined;
  }

  terminals.set(terminal, succeededResult(launchedTerminalReply(terminal, commandArguments)));

  return terminal;
};

// Records the terminal a launch reply names and returns the reply as a successful result.
export const startedTerminalResult = (
  terminals: Map<string, ExecResult>,
  commandArguments: readonly string[],
  reply: string = appSplit,
): ExecResult => {
  recordStartedTerminal(terminals, commandArguments, reply);

  return succeededResult(reply);
};

const routedExec = (
  hc: HcFake,
  app: ExecFake<HerdrAppCommand>,
  terminals: Map<string, ExecResult>,
  afterTerminalLookup: () => Promise<void>,
): Exec => {
  const launchedTerminals = new Set<string>();

  return async (command, commandArguments, options) => {
    if (command === 'herdr-app') {
      const result = await app.exec(command, commandArguments, options);

      const terminal =
        result.code === 0
          ? recordStartedTerminal(terminals, commandArguments, result.stdout)
          : undefined;

      if (terminal !== undefined) {
        launchedTerminals.add(terminal);
      }

      return result;
    }

    if (commandArguments[0] !== 'get') {
      return hc.exec(command, commandArguments, options);
    }

    const address = commandArguments.at(-1) ?? '';
    const terminalReply = terminals.get(address);

    if (terminalReply !== undefined) {
      if (!launchedTerminals.has(address)) {
        await afterTerminalLookup();
      }

      return terminalReply;
    }

    if (address === leadTerminal) {
      return hc.exec(command, commandArguments, options);
    }

    return failedResult(`no such terminal: ${address}`);
  };
};

const leadInSpace = (hc: HcFake, space: string | undefined): void => {
  hc.reply(
    'get',
    JSON.stringify({
      address: leadTerminal,
      state: 'live',
      ...(space === undefined ? {} : { labels: { 'herdr.space': space } }),
    }),
  );
};

const claimArgument = 'TAU_ARCHITECT_CLAIM=';

const claimTokenOf = (commandArguments: readonly string[]): string | undefined => {
  const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

  return argv.find((entry) => entry.startsWith(claimArgument))?.slice(claimArgument.length);
};

export const adoptClaim = async (
  root: string,
  claimToken: string,
  token: string = randomUUID(),
  processId: number = fakeRunningStartProcessId,
): Promise<(() => Promise<void>) | undefined> => {
  const held = await holdFileLock({
    lockPath: architectLockPath(root),
    checkout: root,
    terminal: 't-architect',
    token,
    adopt: claimToken,
  });

  if (held.kind !== 'held') {
    return undefined;
  }

  await replaceCurrentLockOwnerPid(architectLockPath(root), processId);

  await adoptStartMarker(root, claimToken, processId);

  return held.release;
};

// The real herdr-app start launches Pi, which adopts the caller's claim with its next lock
// generation and renames its marker. The fake does the same, so open sees the takeover it waits for.
const takeOverClaim = async (
  root: string,
  commandArguments: readonly string[],
  processId: number,
): Promise<boolean> => {
  const claimToken = claimTokenOf(commandArguments);

  if (claimToken === undefined || claimToken === '') {
    return false;
  }

  const release = await adoptClaim(root, claimToken, randomUUID(), processId);

  if (release === undefined) {
    return false;
  }

  onTestFinished(release);

  return true;
};

const withStartTicket = (
  app: ExecFake<HerdrAppCommand>,
  processId: number,
): ExecFake<HerdrAppCommand> => ({
  ...app,
  exec: async (command, commandArguments, options) => {
    const result = await app.exec(command, commandArguments, options);

    if (result.code === 0) {
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv, processId);
    }

    return result;
  },
});

const withTakeover = (
  app: ExecFake<HerdrAppCommand>,
  root: string,
  processId: number,
  afterTakeover: (() => void) | undefined,
): ExecFake<HerdrAppCommand> => ({
  ...app,
  exec: async (command, commandArguments, options) => {
    const result = await app.exec(command, commandArguments, options);

    if (result.code !== 0) {
      return result;
    }

    const adopted = await takeOverClaim(root, commandArguments, processId);

    if (adopted) {
      afterTakeover?.();
    }

    return result;
  },
});

const wrongModelForeground = (root: string): string =>
  JSON.stringify({
    address: 't-architect',
    state: 'live',
    foreground: {
      pid: 1,
      name: 'pi',
      argv: ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
      cwd: root,
    },
  });

// Answers the model readback with a live terminal that runs another model. A start also reads the
// recorded terminal before it launches, so the answer waits until herdr-app has run.
export const wrongModelReadbackExec = (runtime: HcRuntime, root: string): typeof runtime.exec => {
  let launched = false;

  return async (command, commandArguments, options) => {
    const result = await runtime.exec(command, commandArguments, options);

    launched ||= command === 'herdr-app';

    const readingTerminal =
      command === 'hc' &&
      commandArguments[0] === 'get' &&
      commandArguments.at(-1) === 't-architect';

    return readingTerminal && launched ? succeededResult(wrongModelForeground(root)) : result;
  };
};

export const openRequest = 'Start ME-1540';

export const requestFor = (
  root: string,
  location: OpenRequest['location'],
  hc: OpenRequest['hc'],
  request: string = openRequest,
): OpenRequest => ({
  root,
  leadTerminal: 't-lead',
  request,
  location,
  ui: { notify: vi.fn<() => void>() },
  hc,
});

export const openTool = (
  root: string,
  lead?: { space: string | undefined },
  afterTerminalLookup: () => Promise<void> = () => Promise.resolve(),
  options: OpenToolOptions = {},
): OpenTool => {
  const hc = takingStartTicket(createHcFake());
  const processId = options.takeover === false ? fakeStartProcessId : fakeRunningStartProcessId;
  const fake = withStartTicket(appFake(), processId);

  const processControl =
    options.takeover === false
      ? undefined
      : useFakeStartProcess(onTestFinished, 'running', false, fakeRunningStartProcessId);

  const app =
    options.takeover === false
      ? fake
      : withTakeover(fake, root, fakeRunningStartProcessId, options.afterTakeover);

  const terminals = new Map<string, ExecResult>();

  const leadSpace = lead === undefined ? 'space-1' : lead.space;

  leadInSpace(hc, leadSpace);

  const runtime = { ...hc, exec: routedExec(hc, app, terminals, afterTerminalLookup), cwd: root };

  const tool = createArchitectTool(runtime);

  return { hc, app, terminals, tool, runtime, processControl };
};

export const open = (
  tool: OpenTool['tool'],
  root: string,
  input: { request?: string },
): ReturnType<OpenTool['tool']['execute']> =>
  tool.execute('call', { action: 'open', ...input }, undefined, undefined, contextOf(root));

export const appCommands = (app: ExecFake<HerdrAppCommand>): string[] =>
  app.calls.map((call) => call.commandArguments[1] ?? call.commandArguments[0] ?? '');

export const architectArgv = (app: ExecFake<HerdrAppCommand>): string[] => {
  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');

  return JSON.parse(argumentAfter(split?.commandArguments ?? [], '--argv') ?? '[]') as string[];
};

export const recordTerminal = (root: string, terminal: string, lockToken = 'live'): Promise<void> =>
  writeArchitectRecord(root, {
    version: 2,
    sessionFile: null,
    leadTerminal: 't-lead',
    owner: { lockToken, mode: 'visible', terminal, sessionId: 'session-architect' },
    updatedAt: new Date().toISOString(),
  });

export const recordTerminalV1 = async (root: string, terminal: string): Promise<void> => {
  const path = architectRecordPath(root);

  await mkdir(dirname(path), { recursive: true });

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      sessionFile: null,
      terminal,
      leadTerminal: 't-lead',
      updatedAt: new Date().toISOString(),
    }),
  );
};

export const terminalState = (state: string, labels?: Record<string, string>): ExecResult =>
  succeededResult(
    JSON.stringify({ address: 't-architect', state, ...(labels === undefined ? {} : { labels }) }),
  );

export const writeAsk = (
  root: string,
  terminal: string | null,
  status: 'running' | 'sent',
): Promise<void> =>
  writeAskRecord(root, {
    version: 3,
    route: 'hidden',
    askId: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date().toISOString(),
    question: 'Which flag name?',
    sessionFile: join(root, 'architect-session.jsonl'),
    terminal,
    leadTerminal: 't-lead',
    deadline: Date.now() + 1000,
    status,
    detail: null,
    answer: null,
    gateRecord: null,
  });
