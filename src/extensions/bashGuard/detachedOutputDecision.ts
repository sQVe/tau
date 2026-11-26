import { parseShellCommands } from '../../shell.js';
import type { ShellCommand, ShellRedirection } from '../../shell.js';

export interface DetachedOutputFacts {
  toolName: string;
  command: unknown;
}

interface BlockedDetachedOutput {
  block: true;
  reason: string;
}

export type DetachedOutputDecision = BlockedDetachedOutput | undefined;

type StreamTarget =
  | { kind: 'terminal' }
  | { kind: 'file'; path: string }
  | { kind: 'closed' }
  | { kind: 'unknown' };

// The target of every descriptor the shell redirects. A descriptor the table does not name is the
// terminal for stdout and stderr, and unresolved for any other descriptor.
type Streams = Map<number, StreamTarget>;

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
  // Members below this index sit inside a group whose redirections `inherited` already includes.
  from: number;
  enclosingByIndex: Map<number, Streams>;
}

interface MemberRange {
  start: number;
  end: number;
}

type CompoundFactsOf = (scope: CompoundScope, index: number, depth: number) => CompoundFacts;

const shellNames = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash']);
const devNull = '/dev/null';
const maximumDepth = 4;
const terminalDescriptors = new Set([1, 2]);

const emptyStreams: Streams = new Map();
const terminal: StreamTarget = { kind: 'terminal' };
const unknownTarget: StreamTarget = { kind: 'unknown' };
const emptyOptionValues: ReadonlySet<string> = new Set();

// A wrapper runs the command that follows its own options and fixed arguments.
const wrapperOptionValues: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['-C', '--chdir', '-S', '--split-string', '-u', '--unset']),
  exec: new Set(['-a']),
  sudo: new Set([
    '-C',
    '-D',
    '-g',
    '-h',
    '-p',
    '-r',
    '-t',
    '-T',
    '-u',
    '-U',
    '--chdir',
    '--close-from',
    '--group',
    '--host',
    '--prompt',
    '--role',
    '--type',
    '--user',
  ]),
  timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
};

// The fixed arguments a wrapper takes before the command it runs.
const wrapperArguments = new Map<string, number>([
  ['command', 0],
  ['doas', 0],
  ['env', 0],
  ['exec', 0],
  ['nohup', 0],
  ['setsid', 0],
  ['sudo', 0],
  ['time', 0],
  ['timeout', 1],
]);

const isDescriptor = (target: string): boolean => /^\d+$/u.test(target) || target === '-';

const isOption = (argument: string): boolean => argument.startsWith('-');

const isAssignment = (argument: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument);

const targetOf = (streams: Streams, fileDescriptor: number): StreamTarget => {
  const target = streams.get(fileDescriptor);

  if (target !== undefined) {
    return target;
  }

  return terminalDescriptors.has(fileDescriptor) ? terminal : unknownTarget;
};

const fileTarget = (path: string): StreamTarget => ({ kind: 'file', path });

const duplicatedTarget = (streams: Streams, target: string): StreamTarget => {
  if (target === '-') {
    return { kind: 'closed' };
  }

  if (!/^\d+$/u.test(target)) {
    return unknownTarget;
  }

  return targetOf(streams, Number(target));
};

// `>&word` redirects both streams when word is a file, and duplicates one descriptor when word is a
// number or `-`.
const applyAmpersand = (
  streams: Streams,
  fileDescriptor: number | undefined,
  defaultDescriptor: number,
  target: string,
): void => {
  const descriptor = fileDescriptor ?? defaultDescriptor;

  if (isDescriptor(target)) {
    streams.set(descriptor, duplicatedTarget(streams, target));

    return;
  }

  const file = fileTarget(target);

  if (descriptor === 1 && fileDescriptor === undefined) {
    streams.set(1, file);
    streams.set(2, file);

    return;
  }

  // Bash refuses a numbered `>&` to a file, so this stream is neither a log nor a discard.
  streams.set(descriptor, unknownTarget);
};

const applyRedirection = (streams: Streams, redirection: ShellRedirection): void => {
  const { fileDescriptor, operator, target } = redirection;

  if (operator === '&>' || operator === '&>>') {
    const file = fileTarget(target);

    streams.set(1, file);
    streams.set(2, file);
  } else if (operator === '>' || operator === '>>' || operator === '>|') {
    streams.set(fileDescriptor ?? 1, fileTarget(target));
  } else if (operator === '>&') {
    applyAmpersand(streams, fileDescriptor, 1, target);
  } else if (operator === '<&') {
    applyAmpersand(streams, fileDescriptor, 0, target);
  }
};

const streamsOf = (command: ShellCommand, inherited: Streams): Streams => {
  const streams = new Map(inherited);

  for (const redirection of command.redirections) {
    applyRedirection(streams, redirection);
  }

  return streams;
};

// A stream with no redirection reaches the terminal, which is visible.
const showsStderr = (streams: Streams): boolean => {
  const stderr = targetOf(streams, 2);
  const writesVisibleFile = stderr.kind === 'file' && stderr.path !== devNull;

  return stderr.kind === 'terminal' || writesVisibleFile;
};

const discardsStderr = (streams: Streams): boolean => {
  const stderr = targetOf(streams, 2);
  const writesDevNull = stderr.kind === 'file' && stderr.path === devNull;

  return stderr.kind === 'closed' || writesDevNull;
};

const shellNameOf = (argument: string): string => argument.slice(argument.lastIndexOf('/') + 1);

const skipWrapper = (commandArguments: readonly string[], index: number): number => {
  const name = shellNameOf(commandArguments[index] ?? '');
  const optionValues = wrapperOptionValues[name] ?? emptyOptionValues;
  let next = index + 1;

  while (next < commandArguments.length) {
    const argument = commandArguments[next] ?? '';

    if (!isOption(argument)) {
      break;
    }

    next += optionValues.has(argument) ? 2 : 1;
  }

  if (name === 'env') {
    while (next < commandArguments.length && isAssignment(commandArguments[next] ?? '')) {
      next += 1;
    }
  }

  return next + (wrapperArguments.get(name) ?? 0);
};

const commandHead = (commandArguments: readonly string[]): number => {
  let index = 0;

  while (index < commandArguments.length) {
    const name = shellNameOf(commandArguments[index] ?? '');

    if (!wrapperArguments.has(name)) {
      break;
    }

    index = skipWrapper(commandArguments, index);
  }

  return index;
};

const scriptOf = (command: ShellCommand): string | undefined => {
  const head = commandHead(command.arguments);
  const headName = shellNameOf(command.arguments[head] ?? '');

  if (!shellNames.has(headName)) {
    return undefined;
  }

  const commandFlagIndex = command.arguments.findIndex(
    (argument, index) => index > head && /^-[a-z]*c[a-z]*$/u.test(argument),
  );

  return commandFlagIndex === -1 ? undefined : command.arguments[commandFlagIndex + 1];
};

const encloses = (group: number | undefined, closingIndex: number, index: number): boolean =>
  group !== undefined && group <= index && index < closingIndex;

const enclosingStreams = (
  commands: readonly ShellCommand[],
  index: number,
  inherited: Streams,
  from: number,
): Streams => {
  const enclosing = commands
    .map((command, closingIndex) => ({ command, closingIndex }))
    .filter(({ command, closingIndex }) => {
      const group = command.group;

      return group !== undefined && group >= from && encloses(group, closingIndex, index);
    })
    .toSorted((left, right) => (left.command.group ?? 0) - (right.command.group ?? 0));

  return enclosing.reduce((streams, { command }) => streamsOf(command, streams), inherited);
};

const compoundScope = (
  commands: readonly ShellCommand[],
  inherited: Streams,
  from = 0,
): CompoundScope => ({
  commands,
  inherited,
  from,
  enclosingByIndex: new Map(),
});

const enclosingOf = (scope: CompoundScope, index: number): Streams => {
  const cached = scope.enclosingByIndex.get(index);

  if (cached !== undefined) {
    return cached;
  }

  const enclosing = enclosingStreams(scope.commands, index, scope.inherited, scope.from);

  scope.enclosingByIndex.set(index, enclosing);

  return enclosing;
};

const noFacts: CompoundFacts = { shows: false, discards: false, ownDiscards: false };
const failClosedFacts: CompoundFacts = { shows: false, discards: true, ownDiscards: false };

// The last member with arguments decides whether a reader sees the failure. Any member that throws
// stderr away hides one. An empty member set falls back to the streams the compound inherits.
const membersFacts = (
  factsOf: CompoundFactsOf,
  scope: CompoundScope,
  { start, end }: MemberRange,
  fallbackStreams: Streams,
  depth: number,
): CompoundFacts => {
  let shows: boolean | undefined;

  for (let index = end - 1; index >= start; index -= 1) {
    const command = scope.commands[index];

    if (command !== undefined && command.arguments.length > 0) {
      shows = factsOf(scope, index, depth + 1).shows;

      break;
    }
  }

  let discards = false;

  for (let index = start; index < end; index += 1) {
    const member = factsOf(scope, index, depth + 1);

    discards ||= member.discards || member.ownDiscards;
  }

  return { shows: shows ?? showsStderr(fallbackStreams), discards, ownDiscards: false };
};

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

  const groupStreams = streamsOf(closing, scope.inherited);

  return membersFacts(
    factsOf,
    scope,
    { start: groupStart, end: closingIndex },
    groupStreams,
    depth,
  );
};

const scriptFacts = (
  factsOf: CompoundFactsOf,
  script: string,
  scriptInherited: Streams,
  depth: number,
): CompoundFacts => {
  const commands = parseShellCommands(script);

  // The parser cannot rule out a hidden failure in a script it does not understand.
  if (commands === undefined) {
    return failClosedFacts;
  }

  const scope = compoundScope(commands, scriptInherited);

  return membersFacts(factsOf, scope, { start: 0, end: commands.length }, scriptInherited, depth);
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

  if (script !== undefined) {
    const nested = scriptFacts(compoundFacts, script, own, depth);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  if (command.group !== undefined) {
    const nestedScope = compoundScope(scope.commands, enclosing, command.group);
    const nested = groupFacts(compoundFacts, nestedScope, index, depth);

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

  const own = streamsOf(command, enclosingOf(scope, index));
  const script = scriptOf(command);

  if (script !== undefined || command.group !== undefined) {
    const facts = compoundFacts(scope, index, 0);
    const hidden = !showsStderr(own) && !facts.shows;

    return facts.discards || hidden;
  }

  return !showsStderr(own);
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
