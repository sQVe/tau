import type { ShellCommand, ShellRedirection } from '../../shell.js';

export type StreamTarget =
  | { kind: 'terminal' }
  | { kind: 'file'; path: string }
  | { kind: 'closed' }
  | { kind: 'unknown' };

// The target of every descriptor the shell redirects. A descriptor the table does not name is the
// terminal for stdout and stderr, and unresolved for any other descriptor.
export type Streams = Map<number, StreamTarget>;

export const devNull = '/dev/null';
export const terminal: StreamTarget = { kind: 'terminal' };
const unknownTarget: StreamTarget = { kind: 'unknown' };

const terminalDescriptors = new Set([1, 2]);

export const isDescriptor = (target: string): boolean => /^\d+$/u.test(target) || target === '-';

export const targetOf = (streams: Streams, fileDescriptor: number): StreamTarget => {
  const target = streams.get(fileDescriptor);

  if (target !== undefined) {
    return target;
  }

  return terminalDescriptors.has(fileDescriptor) ? terminal : unknownTarget;
};

// A stream with no redirection reaches the terminal, which is visible.
export const showsStderr = (streams: Streams): boolean => {
  const stderr = targetOf(streams, 2);
  const writesVisibleFile = stderr.kind === 'file' && stderr.path !== devNull;

  return stderr.kind === 'terminal' || writesVisibleFile;
};

export const discardsStderr = (streams: Streams): boolean => {
  const stderr = targetOf(streams, 2);
  const writesDevNull = stderr.kind === 'file' && stderr.path === devNull;

  return stderr.kind === 'closed' || writesDevNull;
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
  } else if (operator === '<>') {
    streams.set(fileDescriptor ?? 0, fileTarget(target));
  } else if (operator === '>&') {
    applyAmpersand(streams, fileDescriptor, 1, target);
  } else if (operator === '<&') {
    applyAmpersand(streams, fileDescriptor, 0, target);
  }
};

// `pipeStdout` is where the command's stdout goes when it writes into a pipeline, so a later
// `2>&1` duplicates the pipe target rather than the terminal.
export const streamsOf = (
  command: ShellCommand,
  inherited: Streams,
  pipeStdout?: StreamTarget,
): Streams => {
  const streams = new Map(inherited);

  if (pipeStdout !== undefined) {
    streams.set(1, pipeStdout);
  }

  for (const redirection of command.redirections) {
    applyRedirection(streams, redirection);
  }

  return streams;
};
