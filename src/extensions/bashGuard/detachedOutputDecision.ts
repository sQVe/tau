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
  readonly shows: boolean;
  readonly discards: boolean;
  readonly ownDiscards: boolean;
}

interface CompoundScope {
  commands: readonly ShellCommand[];
  inherited: Streams;
  enclosingByIndex: Map<number, Streams>;
}

type CompoundFactsOf = (scope: CompoundScope, index: number, depth: number) => CompoundFacts;

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

const encloses = (group: number | undefined, closingIndex: number, index: number): boolean =>
  group !== undefined && group <= index && index < closingIndex;

const enclosingStreams = (
  commands: readonly ShellCommand[],
  index: number,
  inherited: Streams,
): Streams => {
  const enclosing = commands
    .map((command, closingIndex) => ({ command, closingIndex }))
    .filter(({ command, closingIndex }) => encloses(command.group, closingIndex, index))
    .toSorted((left, right) => (left.command.group ?? 0) - (right.command.group ?? 0));

  return enclosing.reduce((streams, { command }) => streamsOf(command, streams), inherited);
};

const compoundScope = (commands: readonly ShellCommand[], inherited: Streams): CompoundScope => ({
  commands,
  inherited,
  enclosingByIndex: new Map(),
});

const enclosingOf = (scope: CompoundScope, index: number): Streams => {
  const cached = scope.enclosingByIndex.get(index);

  if (cached !== undefined) {
    return cached;
  }

  const enclosing = enclosingStreams(scope.commands, index, scope.inherited);

  scope.enclosingByIndex.set(index, enclosing);

  return enclosing;
};

const noFacts: CompoundFacts = { shows: false, discards: false, ownDiscards: false };
const failClosedFacts: CompoundFacts = { shows: false, discards: true, ownDiscards: false };

const groupFacts = (
  factsOf: CompoundFactsOf,
  scope: CompoundScope,
  closingIndex: number,
  depth: number,
): CompoundFacts => {
  const closing = scope.commands[closingIndex];
  const groupStart = closing?.group;

  if (closing === undefined || groupStart === undefined) {
    return noFacts;
  }

  const members = scope.commands
    .map((command, memberIndex) => ({ command, index: memberIndex }))
    .filter(({ index: memberIndex }) => memberIndex >= groupStart && memberIndex < closingIndex);

  const last = members.findLast(({ command }) => command.arguments.length > 0);

  const shows =
    last === undefined
      ? showsStderr(streamsOf(closing, scope.inherited))
      : factsOf(scope, last.index, depth + 1).shows;

  const discards = members.some(({ index: memberIndex }) => {
    const member = factsOf(scope, memberIndex, depth + 1);

    return member.discards || member.ownDiscards;
  });

  return { shows, discards, ownDiscards: false };
};

const scriptFacts = (
  factsOf: CompoundFactsOf,
  script: string,
  scriptInherited: Streams,
  depth: number,
): CompoundFacts => {
  const commands = parseShellCommands(script) ?? [];
  const scope = compoundScope(commands, scriptInherited);
  const lastIndex = commands.findLastIndex((command) => command.arguments.length > 0);

  const shows =
    lastIndex === -1 ? showsStderr(scriptInherited) : factsOf(scope, lastIndex, depth + 1).shows;

  const discards = commands.some((_command, scriptIndex) => {
    const member = factsOf(scope, scriptIndex, depth + 1);

    return member.discards || member.ownDiscards;
  });

  return { shows, discards, ownDiscards: false };
};

// A command shows its failure when its own redirections, over the streams it inherits, end stderr in
// a visible file. A compound shows it when its last non-empty command does. A command that redirects
// anything but leaves stderr discarded hides the failure.
//
// Exceeding the budget fails closed: the compound is treated as discarding, because the parser
// cannot rule out a hidden failure. Group nesting consumes the same budget as script nesting.
const compoundFacts = (scope: CompoundScope, index: number, depth: number): CompoundFacts => {
  if (depth > maximumDepth) {
    return failClosedFacts;
  }

  const command = scope.commands[index];

  if (command === undefined) {
    return noFacts;
  }

  const enclosing = enclosingOf(scope, index);
  const own = streamsOf(command, enclosing);
  const ownDiscards = command.redirections.length > 0 && discardsStderr(own);
  const script = scriptOf(command);

  if (script !== undefined || command.group !== undefined) {
    const nested =
      script === undefined
        ? groupFacts(compoundFacts, compoundScope(scope.commands, enclosing), index, depth)
        : scriptFacts(compoundFacts, script, own, depth);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  return { shows: showsStderr(own), discards: false, ownDiscards };
};

const innermostGroupOf = (
  commands: readonly ShellCommand[],
  index: number,
): ShellCommand | undefined => {
  let innermost: { command: ShellCommand; start: number } | undefined;

  for (const [closingIndex, command] of commands.entries()) {
    const start = command.group;

    if (start === undefined || !encloses(start, closingIndex, index)) {
      continue;
    }

    if (innermost === undefined || start > innermost.start) {
      innermost = { command, start };
    }
  }

  return innermost?.command;
};

// A backgrounded group is judged as a whole, so its members are not judged again. A command
// backgrounded inside a foreground group still carries its own hidden failure.
const insideBackgroundedGroup = (commands: readonly ShellCommand[], index: number): boolean =>
  innermostGroupOf(commands, index)?.background === true;

const hidesFailure = (scope: CompoundScope, index: number): boolean => {
  const command = scope.commands[index];

  if (command === undefined || !command.background) {
    return false;
  }

  const enclosing = enclosingOf(scope, index);
  const own = streamsOf(command, enclosing);
  const script = scriptOf(command);

  if (script !== undefined || command.group !== undefined) {
    const facts = compoundFacts(scope, index, 0);
    const ownHidden = facts.ownDiscards && !facts.shows;

    return facts.discards || ownHidden;
  }

  return discardsStderr(own) && !showsStderr(own);
};

// A command the parser creates at an opening parenthesis has no arguments and closes no group, so
// judging it would read the enclosing redirections as its own.
const isJudgedCommand = (command: ShellCommand): boolean =>
  command.group !== undefined || command.arguments.length > 0;

const judgesHiddenFailure = (scope: CompoundScope, index: number): boolean => {
  const command = scope.commands[index];

  if (command === undefined || !isJudgedCommand(command)) {
    return false;
  }

  return !insideBackgroundedGroup(scope.commands, index) && hidesFailure(scope, index);
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

  const scope = compoundScope(commands, emptyStreams);

  return commands.some((_command, index) => judgesHiddenFailure(scope, index))
    ? { block: true, reason: blockReason }
    : undefined;
};
