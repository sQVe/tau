import type { CommandRuntime } from '../../command.js';
import { get, HcError } from '../../hc/hc.js';
import { startPiSession } from '../../piStart/piStart.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { readHandoverText } from './handoverFile.js';

export type StartHandoverTarget = { space: string } | { name: string };

export interface StartHandoverRequest {
  cwd: string;
  file: string;
  folder: string;
  target: StartHandoverTarget;
  model: string | undefined;
  bareRoot: boolean;
}

export interface StartHandoverResult {
  reply: string;
}

const isMissingTerminal = (error: unknown): boolean =>
  error instanceof HcError && error.kind === 'not_found';

export const startHandover = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<StartHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  const target: PiStartTarget =
    'space' in request.target
      ? {
          space: request.target.space,
          readForeground: async (terminal) => {
            try {
              const found = await get(runtime, terminal);

              return found.foreground;
            } catch (error) {
              if (isMissingTerminal(error)) {
                return undefined;
              }

              throw error;
            }
          },
        }
      : request.target;

  return startPiSession(runtime, {
    folder: request.folder,
    target,
    task: text,
    model: request.model,
    session: undefined,
    bareRoot: request.bareRoot,
    environment: undefined,
  });
};
