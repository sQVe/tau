import { Type } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';

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

export const findPane = async (
  runtime: CommandRuntime,
  terminal: string,
): Promise<string | undefined> => {
  const output = await runCommand(runtime, 'herdr-app', ['ls'], 'herdr-app ls');
  const layout = parseJson('herdr-app ls', output);

  checkOutput('herdr-app ls', herdrLayoutSchema, layout);

  const terminals = layout.spaces.flatMap((space) => space.tabs.flatMap((tab) => tab.terminals));
  const match = terminals.find((candidate) => candidate.terminal === terminal);

  return match?.pane ?? undefined;
};
