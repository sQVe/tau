import { Type } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';

export interface HerdrSpace {
  id: string;
  name: string;
  folder: string;
  machine: string | null;
}

const herdrLayoutSchema = Type.Object({
  spaces: Type.Array(
    Type.Object({
      tabs: Type.Array(
        Type.Object({
          terminals: Type.Array(
            Type.Object({
              terminal: Type.String(),
              pane: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
          ),
        }),
      ),
    }),
  ),
});

const herdrSpacesSchema = Type.Object({
  spaces: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      folder: Type.String(),
      machine: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

const readLayout = async (runtime: CommandRuntime): Promise<unknown> => {
  const output = await runCommand(runtime, 'herdr-app', ['ls'], 'herdr-app ls');

  return parseJson('herdr-app ls', output);
};

export const findPane = async (
  runtime: CommandRuntime,
  terminal: string,
): Promise<string | undefined> => {
  const layout = await readLayout(runtime);

  checkOutput('herdr-app ls', herdrLayoutSchema, layout);

  const terminals = layout.spaces.flatMap((space) => space.tabs.flatMap((tab) => tab.terminals));
  const match = terminals.find((candidate) => candidate.terminal === terminal);

  return match?.pane ?? undefined;
};

export const listSpaces = async (runtime: CommandRuntime): Promise<HerdrSpace[]> => {
  const layout = await readLayout(runtime);

  checkOutput('herdr-app ls', herdrSpacesSchema, layout);

  return layout.spaces.map(({ id, name, folder, machine }) => ({ id, name, folder, machine }));
};
