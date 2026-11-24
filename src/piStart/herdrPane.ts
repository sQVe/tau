import type { Static } from 'typebox';
import { Type } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';

const herdrSpaceFields = {
  id: Type.String(),
  name: Type.String(),
  folder: Type.String(),
  machine: Type.Union([Type.String(), Type.Null()]),
};

// findPane reads only tabs and terminals, so a listing may leave out the space fields.
const optionalHerdrSpaceFields = Type.Partial(Type.Object(herdrSpaceFields)).properties;

const herdrLayoutSchema = Type.Object({
  spaces: Type.Array(
    Type.Object({
      ...optionalHerdrSpaceFields,
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
  spaces: Type.Array(Type.Object(herdrSpaceFields)),
});

export type HerdrSpace = Static<typeof herdrSpacesSchema>['spaces'][number];

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

  return layout.spaces;
};
