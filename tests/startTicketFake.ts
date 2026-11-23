import { execFile } from 'node:child_process';
import { rename } from 'node:fs/promises';
import { promisify } from 'node:util';

interface StartTicketPaths {
  ticket: string;
  started: string;
}

const wrapperName = 'tau-architect-start';
const run = promisify(execFile);

const startTicketOf = (argv: readonly string[]): StartTicketPaths | undefined => {
  const index = argv.indexOf(wrapperName);
  const ticket = argv[index + 1];
  const started = argv[index + 2];

  if (index === -1 || ticket === undefined || started === undefined) {
    return undefined;
  }

  return { ticket, started };
};

// The child renames the ticket before it runs Pi. A fake launcher calls this to model that step.
export const takeStartTicket = async (argv: readonly string[]): Promise<boolean> => {
  const paths = startTicketOf(argv);

  if (paths === undefined) {
    return false;
  }

  try {
    await rename(paths.ticket, paths.started);

    return true;
  } catch {
    return false;
  }
};

export const runLaunchArgv = async (argv: readonly string[], cwd: string): Promise<number> => {
  const [command, ...commandArguments] = argv;

  if (command === undefined) {
    return -1;
  }

  try {
    await run(command, commandArguments, { cwd });

    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
};
