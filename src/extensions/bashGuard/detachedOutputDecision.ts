import { parseShellCommands } from '../../shell.js';
import type { ShellCommand } from '../../shell.js';

export interface DetachedOutputFacts {
  toolName: string;
  command: unknown;
}

interface BlockedDetachedOutput {
  block: true;
  reason: string;
}

export type DetachedOutputDecision = BlockedDetachedOutput | undefined;

type StreamTarget = { kind: 'file'; path: string } | { kind: 'closed' } | { kind: 'unknown' };

interface Streams {
  stdout: StreamTarget | undefined;
  stderr: StreamTarget | undefined;
}

interface ScriptFacts {
  logs: boolean;
  discards: boolean;
}

type ScriptFactsOf = (script: string | undefined, depth: number) => ScriptFacts;

const shellNames = new Set(['sh', 'bash', 'dash', 'zsh']);
const devNull = '/dev/null';

const isDescriptor = (target: string): boolean => /^\d+$/u.test(target) || target === '-';

const setStream = (
  streams: Streams,
  fileDescriptor: number | undefined,
  target: StreamTarget,
): void => {
  if (fileDescriptor === 2) {
    streams.stderr = target;
  } else if (fileDescriptor === undefined || fileDescriptor === 1) {
    streams.stdout = target;
  }
};

const duplicatedTarget = (streams: Streams, target: string): StreamTarget => {
  if (target === '-') {
    return { kind: 'closed' };
  }

  if (target === '1') {
    return streams.stdout ?? { kind: 'unknown' };
  }

  if (target === '2') {
    return streams.stderr ?? { kind: 'unknown' };
  }

  return { kind: 'unknown' };
};

// `>&word` redirects both streams when word is a file, and duplicates one descriptor when word is a
// number or `-`.
const applyAmpersand = (
  streams: Streams,
  fileDescriptor: number | undefined,
  target: string,
): void => {
  if (isDescriptor(target)) {
    setStream(streams, fileDescriptor, duplicatedTarget(streams, target));

    return;
  }

  const file: StreamTarget = { kind: 'file', path: target };

  if (fileDescriptor === undefined) {
    streams.stdout = file;
    streams.stderr = file;

    return;
  }

  // Bash refuses a numbered `>&` to a file, so this stream is neither a log nor a discard.
  setStream(streams, fileDescriptor, { kind: 'unknown' });
};

const applyRedirection = (
  streams: Streams,
  redirection: ShellCommand['redirections'][number],
): void => {
  const { fileDescriptor, operator, target } = redirection;

  if (operator === '&>' || operator === '&>>') {
    streams.stdout = { kind: 'file', path: target };
    streams.stderr = { kind: 'file', path: target };
  } else if (['>', '>>', '>|'].includes(operator)) {
    setStream(streams, fileDescriptor, { kind: 'file', path: target });
  } else if (operator === '>&') {
    applyAmpersand(streams, fileDescriptor, target);
  }
};

const streamsOf = (command: ShellCommand): Streams => {
  const streams: Streams = { stdout: undefined, stderr: undefined };

  for (const redirection of command.redirections) {
    applyRedirection(streams, redirection);
  }

  return streams;
};

const discardsStderr = (command: ShellCommand): boolean => {
  const stderr = streamsOf(command).stderr;

  if (stderr === undefined) {
    return false;
  }

  const writesDevNull = stderr.kind === 'file' && stderr.path === devNull;

  return stderr.kind === 'closed' || writesDevNull;
};

// Only a resolved file target keeps the output where a later read can see it.
const logsStderr = (command: ShellCommand): boolean => {
  const stderr = streamsOf(command).stderr;

  return stderr?.kind === 'file' && stderr.path !== devNull;
};

const shellNameOf = (argument: string): string => argument.slice(argument.lastIndexOf('/') + 1);

const maximumScriptDepth = 4;

const scriptOf = (command: ShellCommand): string | undefined => {
  const shellIndex = command.arguments.findIndex((argument) =>
    shellNames.has(shellNameOf(argument)),
  );

  if (shellIndex === -1) {
    return undefined;
  }

  const commandFlagIndex = command.arguments.findIndex(
    (argument, index) => index > shellIndex && /^-[a-z]*c[a-z]*$/u.test(argument),
  );

  return commandFlagIndex === -1 ? undefined : command.arguments[commandFlagIndex + 1];
};

const commandsFacts = (
  commands: readonly ShellCommand[],
  depth: number,
  scriptFactsOf: ScriptFactsOf,
): ScriptFacts =>
  commands.reduce<ScriptFacts>(
    (facts, command) => {
      const nestedScript = scriptOf(command);

      const nested =
        nestedScript === undefined
          ? { logs: false, discards: false }
          : scriptFactsOf(nestedScript, depth + 1);

      return {
        logs: facts.logs || logsStderr(command) || nested.logs,
        discards: facts.discards || discardsStderr(command) || nested.discards,
      };
    },
    { logs: false, discards: false },
  );

// Fail closed past the depth budget, so a deeply nested script is treated as hiding its stderr.
const scriptFacts = (script: string | undefined, depth = 0): ScriptFacts => {
  if (depth > maximumScriptDepth) {
    return { logs: false, discards: true };
  }

  const commands = (parseShellCommands(script ?? '') ?? []).filter(
    (command) => command.arguments.length > 0,
  );

  return commandsFacts(commands, depth, scriptFacts);
};

const unitFacts = (commands: readonly ShellCommand[], command: ShellCommand): ScriptFacts =>
  commandsFacts(
    commands.filter(
      (candidate) =>
        candidate.unit === command.unit && candidate.arguments.length > 0 && candidate !== command,
    ),
    0,
    scriptFacts,
  );

// The outer redirection hides the script's own stderr. A script keeps it when some command writes
// stderr to a file and no command sends stderr to /dev/null.
const scriptKeepsStderr = (script: string): boolean => {
  const facts = scriptFacts(script);

  return facts.logs && !facts.discards;
};

const scriptDiscardsStderr = (script: string | undefined): boolean => scriptFacts(script).discards;

const hidesFailure = (command: ShellCommand, commands: readonly ShellCommand[]): boolean => {
  if (!command.background) {
    return false;
  }

  if (command.arguments.length === 0) {
    if (!discardsStderr(command)) {
      return false;
    }

    const facts = unitFacts(commands, command);

    return !facts.logs || facts.discards;
  }

  const script = scriptOf(command);

  if (!discardsStderr(command)) {
    return scriptDiscardsStderr(script);
  }

  return script === undefined || !scriptKeepsStderr(script);
};

const blockReason =
  'This bash command detaches a process and sends its stderr to /dev/null, so a failure would be hidden. Write the output to a log file, such as `> /tmp/<name>.log 2>&1`, then read the log and the exit status before reporting the effect.';

export const decideDetachedOutput = (facts: DetachedOutputFacts): DetachedOutputDecision => {
  if (facts.toolName !== 'bash' || typeof facts.command !== 'string') {
    return undefined;
  }

  const commands = parseShellCommands(facts.command);

  if (commands === undefined) {
    return undefined;
  }

  return commands.some((command) => hidesFailure(command, commands))
    ? { block: true, reason: blockReason }
    : undefined;
};
