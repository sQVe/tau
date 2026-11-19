import { Type } from 'typebox';
import type { Static } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';

const herdrSpaceSchema = Type.Object({
  id: Type.String(),
  tabs: Type.Array(
    Type.Object({
      terminals: Type.Array(
        Type.Object({
          terminal: Type.String(),
          pane: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          app: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
      ),
    }),
  ),
});

export type HerdrSpace = Static<typeof herdrSpaceSchema>;

const herdrLayoutSchema = Type.Object({ spaces: Type.Array(herdrSpaceSchema) });

export const readHerdrLayout = async (
  runtime: CommandRuntime,
): Promise<{ spaces: HerdrSpace[] }> => {
  const output = await runCommand(runtime, 'herdr-app', ['ls'], 'herdr-app ls');
  const layout = parseJson('herdr-app ls', output);

  checkOutput('herdr-app ls', herdrLayoutSchema, layout);

  return layout;
};

export const findPane = async (
  runtime: CommandRuntime,
  terminal: string,
): Promise<string | undefined> => {
  const layout = await readHerdrLayout(runtime);

  const terminals = layout.spaces.flatMap((space) => space.tabs.flatMap((tab) => tab.terminals));
  const match = terminals.find((candidate) => candidate.terminal === terminal);

  return match?.pane ?? undefined;
};
