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

// Whether a reader sees a compound's failure, whether a command inside it throws stderr away, and
// whether the command's own redirection does.
interface CompoundFacts {
  shows: boolean;
  discards: boolean;
  ownDiscards: boolean;
}

const shellNames = new Set(['sh', 'bash', 'dash', 'zsh']);
const devNull = '/dev/null';
const maximumDepth = 4;

const emptyStreams: Streams = { stdout: undefined, stderr: undefined };

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

const streamsOf = (command: ShellCommand, inherited: Streams): Streams => {
  const streams: Streams = { ...inherited };

  for (const redirection of command.redirections) {
    applyRedirection(streams, redirection);
  }

  return streams;
};

// A stream with no redirection reaches the terminal, which is visible.
const showsStderr = (streams: Streams): boolean => {
  const stderr = streams.stderr;

  const writesVisibleFile = stderr?.kind === 'file' && stderr.path !== devNull;

  return stderr === undefined || writesVisibleFile;
};

const discardsStderr = (streams: Streams): boolean => {
  const stderr = streams.stderr;
  const writesDevNull = stderr?.kind === 'file' && stderr.path === devNull;

  return stderr?.kind === 'closed' || writesDevNull;
};

const shellNameOf = (argument: string): string => argument.slice(argument.lastIndexOf('/') + 1);

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

const encloses = (command: ShellCommand, closingIndex: number, index: number): boolean =>
  command.group !== undefined && command.group <= index && index < closingIndex;

const enclosingStreams = (
  commands: readonly ShellCommand[],
  index: number,
  inherited: Streams,
): Streams => {
  const enclosing = commands
    .map((command, closingIndex) => ({ command, closingIndex }))
    .filter(({ command, closingIndex }) => encloses(command, closingIndex, index))
    .toSorted((left, right) => (left.command.group ?? 0) - (right.command.group ?? 0));

  return enclosing.reduce((streams, { command }) => streamsOf(command, streams), inherited);
};

// A command shows its failure when its own redirections, over the streams it inherits, end stderr in
// a visible file. A group shows it when its first command does, and a script when its last command
// does. A command that redirects anything but leaves stderr discarded hides the failure.
const compoundFacts = (
  commands: readonly ShellCommand[],
  index: number,
  inherited: Streams,
  depth: number,
): CompoundFacts => {
  const groupFacts = (closingIndex: number, groupInherited: Streams): CompoundFacts => {
    const closing = commands[closingIndex];
    const groupStart = closing?.group;

    if (closing === undefined || groupStart === undefined) {
      return { shows: false, discards: false, ownDiscards: false };
    }

    const members = commands
      .map((command, memberIndex) => ({ command, index: memberIndex }))
      .filter(({ index: memberIndex }) => memberIndex >= groupStart && memberIndex < closingIndex);

    const first = members.find(({ command }) => command.arguments.length > 0);

    const shows =
      first === undefined
        ? showsStderr(streamsOf(closing, groupInherited))
        : compoundFacts(commands, first.index, groupInherited, depth + 1).shows;

    const discards = members.some(({ index: memberIndex }) => {
      const member = compoundFacts(commands, memberIndex, groupInherited, depth + 1);

      return member.discards || member.ownDiscards;
    });

    return { shows, discards, ownDiscards: false };
  };

  const scriptFacts = (script: string, scriptInherited: Streams): CompoundFacts => {
    const scriptCommands = parseShellCommands(script) ?? [];
    const lastIndex = scriptCommands.findLastIndex((command) => command.arguments.length > 0);

    const shows =
      lastIndex === -1
        ? showsStderr(scriptInherited)
        : compoundFacts(scriptCommands, lastIndex, scriptInherited, depth + 1).shows;

    const discards = scriptCommands.some((_command, scriptIndex) => {
      const member = compoundFacts(scriptCommands, scriptIndex, scriptInherited, depth + 1);

      return member.discards || member.ownDiscards;
    });

    return { shows, discards, ownDiscards: false };
  };

  if (depth > maximumDepth) {
    return { shows: false, discards: true, ownDiscards: false };
  }

  const command = commands[index];

  if (command === undefined) {
    return { shows: false, discards: false, ownDiscards: false };
  }

  const enclosing = enclosingStreams(commands, index, inherited);
  const own = streamsOf(command, enclosing);
  const ownDiscards = command.redirections.length > 0 && discardsStderr(own);
  const script = scriptOf(command);

  if (script !== undefined) {
    const nested = scriptFacts(script, own);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  if (command.group !== undefined) {
    const nested = groupFacts(index, enclosing);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  return { shows: showsStderr(own), discards: false, ownDiscards };
};

const insideGroup = (commands: readonly ShellCommand[], index: number): boolean =>
  commands.some((command, closingIndex) => encloses(command, closingIndex, index));

const hidesFailure = (commands: readonly ShellCommand[], index: number): boolean => {
  const command = commands[index];

  if (command === undefined || !command.background) {
    return false;
  }

  const enclosing = enclosingStreams(commands, index, emptyStreams);
  const own = streamsOf(command, enclosing);
  const script = scriptOf(command);

  if (script !== undefined) {
    const facts = compoundFacts(commands, index, enclosing, 0);
    const ownHidden = facts.ownDiscards && !facts.shows;

    return facts.discards || ownHidden;
  }

  if (command.group !== undefined) {
    const facts = compoundFacts(commands, index, enclosing, 0);
    const ownHidden = facts.ownDiscards && !facts.shows;

    return facts.discards || ownHidden;
  }

  return discardsStderr(own) && !showsStderr(own);
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

  return commands.some(
    (_command, index) => !insideGroup(commands, index) && hidesFailure(commands, index),
  )
    ? { block: true, reason: blockReason }
    : undefined;
};
