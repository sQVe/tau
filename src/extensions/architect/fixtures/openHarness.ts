import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { onTestFinished } from 'vitest';

import { argumentAfter, failedResult, succeededResult } from '../../../../tests/execFake.js';
import type { ExecFake, ExecResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { createHerdrAppFake } from '../../../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../../../tests/herdrAppFake.js';
import type { Exec } from '../../../command.js';
import { holdFileLock } from '../../../fileLock/fileLock.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { architectLockPath } from '../lock.js';
import { architectRecordPath, writeArchitectRecord, writeAskRecord } from '../record.js';
import { createArchitectTool } from '../tool.js';
import { contextOf } from './toolHarness.js';

interface OpenTool {
  hc: HcFake;
  app: ExecFake<HerdrAppCommand>;
  terminals: Map<string, ExecResult>;
  tool: ReturnType<typeof createArchitectTool>;
  runtime: HcRuntime;
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

  return app;
};

const leadTerminal = 't-lead';

const routedExec =
  (
    hc: HcFake,
    app: ExecFake<HerdrAppCommand>,
    terminals: Map<string, ExecResult>,
    afterTerminalLookup: () => Promise<void>,
  ): Exec =>
  async (command, commandArguments, options) => {
    if (command === 'herdr-app') {
      return app.exec(command, commandArguments, options);
    }

    if (commandArguments[0] !== 'get') {
      return hc.exec(command, commandArguments, options);
    }

    const address = commandArguments.at(-1) ?? '';
    const terminalReply = terminals.get(address);

    if (terminalReply !== undefined) {
      await afterTerminalLookup();

      return terminalReply;
    }

    if (address === leadTerminal) {
      return hc.exec(command, commandArguments, options);
    }

    return failedResult(`no such terminal: ${address}`);
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

// The real herdr-app start launches Pi, which adopts the caller's claim with its next lock
// generation. The fake does the same, so open sees the takeover it waits for.
const takeOverClaim = async (root: string, commandArguments: readonly string[]): Promise<void> => {
  const claimToken = claimTokenOf(commandArguments);

  if (claimToken === undefined || claimToken === '') {
    return;
  }

  const held = await holdFileLock({
    lockPath: architectLockPath(root),
    checkout: root,
    terminal: 't-architect',
    token: randomUUID(),
    adopt: claimToken,
  });

  if (held.kind === 'held') {
    onTestFinished(held.release);
  }
};

const withTakeover = (
  app: ExecFake<HerdrAppCommand>,
  root: string,
  afterTakeover: (() => void) | undefined,
): ExecFake<HerdrAppCommand> => ({
  ...app,
  exec: async (command, commandArguments, options) => {
    const result = await app.exec(command, commandArguments, options);

    await takeOverClaim(root, commandArguments);
    afterTakeover?.();

    return result;
  },
});

export const openRequest = 'Start ME-1540';

export const openTool = (
  root: string,
  lead?: { space: string | undefined },
  afterTerminalLookup: () => Promise<void> = () => Promise.resolve(),
  options: OpenToolOptions = {},
): OpenTool => {
  const hc = createHcFake();
  const fake = appFake();

  const app = options.takeover === false ? fake : withTakeover(fake, root, options.afterTakeover);

  const terminals = new Map<string, ExecResult>();

  const leadSpace = lead === undefined ? 'space-1' : lead.space;

  leadInSpace(hc, leadSpace);

  const runtime = { ...hc, exec: routedExec(hc, app, terminals, afterTerminalLookup), cwd: root };

  const tool = createArchitectTool(runtime);

  return { hc, app, terminals, tool, runtime };
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
