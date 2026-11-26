import { parseShellCommands, runsRedirectionsOnlyExec, shellScriptOf } from '../../shell.js';
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

type CompoundFactsOf = (scope: CompoundScope, index: number, depth: number) => CompoundFacts;

interface EnclosingGroup {
  readonly closing: ShellCommand;
  readonly start: number;
}

const devNull = '/dev/null';
const maximumDepth = 4;
const terminalDescriptors = new Set([1, 2]);

const emptyStreams: Streams = new Map();
const terminal: StreamTarget = { kind: 'terminal' };
const unknownTarget: StreamTarget = { kind: 'unknown' };

const isDescriptor = (target: string): boolean => /^\d+$/u.test(target) || target === '-';

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

const encloses = (group: number | undefined, closingIndex: number, index: number): boolean =>
  group !== undefined && group <= index && index < closingIndex;

const innermostGroupOf = (
  commands: readonly ShellCommand[],
  index: number,
): EnclosingGroup | undefined => {
  let innermost: EnclosingGroup | undefined;

  for (const [closingIndex, command] of commands.entries()) {
    const start = command.group;

    if (start === undefined || !encloses(start, closingIndex, index)) {
      continue;
    }

    if (innermost === undefined || start > innermost.start) {
      innermost = { closing: command, start };
    }
  }

  return innermost;
};

// A command in a child shell inherits the descriptors its parent has when it starts, so an `exec`
// in the parent changes them too. An `exec` in a child shell never reaches the parent.
const runsInShellOf = (command: ShellCommand, shellOwner: ShellCommand): boolean =>
  command.shellId === shellOwner.shellId || command.shellId.startsWith(`${shellOwner.shellId}.`);

// `exec` with only redirections changes the shell's own descriptors for the commands that follow
// it in that shell. A command outside that shell does not inherit the change.
const changesShellStreams = (command: ShellCommand): boolean =>
  command.redirections.length > 0 && runsRedirectionsOnlyExec(command.arguments);

// Applies the `exec` commands whose innermost group is `group`, in source order. The enclosing
// groups apply their own redirections between these passes, so a group redirection that starts
// after an inherited `exec` still wins.
const applyExecRedirections = (
  scope: CompoundScope,
  index: number,
  inherited: Streams,
  group: ShellCommand | undefined,
): Streams => {
  const { commands, from } = scope;
  const target = commands[index];
  let streams = inherited;

  if (target === undefined) {
    return streams;
  }

  for (let earlier = from; earlier < index; earlier += 1) {
    const earlierCommand = commands[earlier];

    // Most scripts contain no `exec`, so reject one before the group scan.
    if (earlierCommand === undefined || !changesShellStreams(earlierCommand)) {
      continue;
    }

    if (!runsInShellOf(target, earlierCommand)) {
      continue;
    }

    if (innermostGroupOf(commands, earlier)?.closing !== group) {
      continue;
    }

    streams = streamsOf(earlierCommand, streams);
  }

  return streams;
};

const enclosingStreams = (scope: CompoundScope, index: number): Streams => {
  const { commands, inherited, from } = scope;

  const enclosing = commands
    .map((command, closingIndex) => ({ command, closingIndex }))
    .filter(({ command, closingIndex }) => {
      const group = command.group;

      return group !== undefined && group >= from && encloses(group, closingIndex, index);
    })
    .toSorted((left, right) => (left.command.group ?? 0) - (right.command.group ?? 0));

  let streams = applyExecRedirections(scope, index, inherited, undefined);

  for (const { command } of enclosing) {
    streams = applyExecRedirections(scope, index, streamsOf(command, streams), command);
  }

  return streams;
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

  const enclosing = enclosingStreams(scope, index);

  scope.enclosingByIndex.set(index, enclosing);

  return enclosing;
};

const noFacts: CompoundFacts = { shows: false, discards: false, ownDiscards: false };
const failClosedFacts: CompoundFacts = { shows: false, discards: true, ownDiscards: false };

const memberRangeWithFallbackOf = (
  scope: CompoundScope,
  closingIndex: number | undefined,
): { start: number; end: number; fallbackStreams: Streams } => {
  const closing = closingIndex === undefined ? undefined : scope.commands[closingIndex];
  const start = closing?.group ?? 0;
  const end = closingIndex ?? scope.commands.length;

  const fallbackStreams =
    closing === undefined ? scope.inherited : streamsOf(closing, scope.inherited);

  return { start, end, fallbackStreams };
};

// The last member with arguments decides whether a reader sees the failure. Any member that throws
// stderr away hides one. An empty member set falls back to the streams the compound inherits.
const membersFacts = (
  factsOf: CompoundFactsOf,
  scope: CompoundScope,
  closingIndex: number | undefined,
  depth: number,
): CompoundFacts => {
  const { start, end, fallbackStreams } = memberRangeWithFallbackOf(scope, closingIndex);
  let shows: boolean | undefined;
  let discards = false;

  for (let index = start; index < end; index += 1) {
    const member = factsOf(scope, index, depth + 1);
    const hasArguments = (scope.commands[index]?.arguments.length ?? 0) > 0;

    if (hasArguments) {
      shows = member.shows;
    }

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

  if (closing?.group === undefined) {
    return noFacts;
  }

  return membersFacts(factsOf, scope, closingIndex, depth);
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

  return membersFacts(factsOf, scope, undefined, depth);
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
  const script = shellScriptOf(command.arguments);

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

// A backgrounded group is judged as a whole, so its members are not judged again. A command
// backgrounded inside a foreground group still carries its own hidden failure.
const insideBackgroundedGroup = (commands: readonly ShellCommand[], index: number): boolean =>
  innermostGroupOf(commands, index)?.closing.background === true;

const hidesFailure = (scope: CompoundScope, index: number): boolean => {
  const command = scope.commands[index];

  if (command === undefined || !command.background) {
    return false;
  }

  const own = streamsOf(command, enclosingOf(scope, index));
  const script = shellScriptOf(command.arguments);

  if (script !== undefined || command.group !== undefined) {
    const facts = compoundFacts(scope, index, 0);
    const hidden = !showsStderr(own) && !facts.shows;

    return facts.discards || hidden;
  }

  return !showsStderr(own);
};

// A redirection-only `exec` runs no command, so it has no failure to hide unless one of its
// redirections can fail while stderr is discarded.
const redirectionCanFail = (redirection: ShellRedirection): boolean => {
  const { operator, target } = redirection;

  if (operator === '>&' || operator === '<&') {
    return !isDescriptor(target) && target !== devNull;
  }

  if (operator === '<<' || operator === '<<-' || operator === '<<<') {
    return false;
  }

  return target !== devNull;
};

// A command the parser creates at an opening parenthesis has no arguments and closes no group, so
// judging it would read the enclosing redirections as its own.
const isJudgedCommand = (command: ShellCommand): boolean => {
  if (runsRedirectionsOnlyExec(command.arguments)) {
    return command.redirections.some(redirectionCanFail);
  }

  return command.group !== undefined || command.arguments.length > 0;
};

const judgesHiddenFailure = (scope: CompoundScope, index: number, depth = 0): boolean => {
  const command = scope.commands[index];

  if (command === undefined || !isJudgedCommand(command)) {
    return false;
  }

  if (insideBackgroundedGroup(scope.commands, index)) {
    return false;
  }

  if (hidesFailure(scope, index)) {
    return true;
  }

  if (command.background) {
    return false;
  }

  const script = shellScriptOf(command.arguments);

  if (script === undefined) {
    return false;
  }

  // A foreground command that runs a script still detaches the script's own backgrounded members.
  // Exceeding the budget fails closed, because a deeper script may detach a hidden failure.
  if (depth > maximumDepth) {
    return true;
  }

  const commands = parseShellCommands(script);

  if (commands === undefined) {
    return false;
  }

  const inherited = streamsOf(command, enclosingOf(scope, index));
  const nested = compoundScope(commands, inherited);

  return commands.some((_nested, nestedIndex) =>
    judgesHiddenFailure(nested, nestedIndex, depth + 1),
  );
};

const blockReason =
  'This bash command detaches a process and discards or closes its stderr, so a failure would be hidden. Write the output to a log file, such as `> /tmp/<name>.log 2>&1`, then read the log and the exit status before reporting the effect.';

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
