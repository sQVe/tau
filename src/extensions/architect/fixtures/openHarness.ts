import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { argumentAfter, failedResult, succeededResult } from '../../../../tests/execFake.js';
import type { ExecFake, ExecResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { createHerdrAppFake } from '../../../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../../../tests/herdrAppFake.js';
import type { Exec } from '../../../command.js';
import type { HcRuntime } from '../../../hc/hc.js';
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

export const openRequest = 'Start ME-1540';

export const openTool = (
  root: string,
  lead?: { space: string | undefined },
  afterTerminalLookup: () => Promise<void> = () => Promise.resolve(),
): OpenTool => {
  const hc = createHcFake();
  const app = appFake();

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
