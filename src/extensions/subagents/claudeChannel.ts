// Claude runs this file directly, so it must stay dependency-free: node builtins only, no Tau imports.
// It carries hook payloads and MCP frames to the parent-owned socket. All decisions stay in the parent.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';

const blockingEvents = new Set(['UserPromptSubmit', 'PreToolUse']);

// Exiting before a pipe flushes would drop a denial, so leave only after every write completes.
const finish = (code: number, stdout?: string, stderr?: string): void => {
  let pending = 0;
  const done = () => {
    pending -= 1;

    if (pending <= 0) {
      process.exit(code);
    }
  };

  if (stdout) {
    pending += 1;
    process.stdout.write(stdout, done);
  }
  if (stderr) {
    pending += 1;
    process.stderr.write(stderr, done);
  }

  if (!pending) {
    process.exit(code);
  }
};

// Only work-authorizing hooks fail closed; informational hooks must still let Claude exit.
const fail = (event: string | undefined, reason: string): void => {
  finish(event && blockingEvents.has(event) ? 2 : 0, undefined, `${reason}\n`);
};

const open = (socketPath: string, onError: (error: Error) => void): Socket => {
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  socket.once('error', onError);

  return socket;
};

const readPayload = (event: string): unknown => {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }

  if (!input.trim()) {
    return {};
  }

  try {
    return JSON.parse(input);
  } catch {
    fail(event, 'Tau channel received a malformed hook payload.');

    return undefined;
  }
};

const answer = (event: string, answered: string): void => {
  const line = answered.split('\n').find((entry) => entry.trim());
  let decision: unknown;
  try {
    decision = line === undefined ? undefined : JSON.parse(line);
  } catch {
    decision = undefined;
  }

  if (typeof decision !== 'object' || decision === null) {
    fail(event, 'Tau worker channel returned no usable decision.');

    return;
  }

  const fields: Record<string, unknown> = { ...decision };
  if (fields.blocked === true) {
    // The parent could not read this frame, so this event decides for itself what a refusal means.
    fail(event, typeof fields.stderr === 'string' ? fields.stderr : 'Tau worker channel refused.');

    return;
  }

  finish(
    typeof fields.exitCode === 'number' ? fields.exitCode : 0,
    typeof fields.stdout === 'string' ? fields.stdout : undefined,
    typeof fields.stderr === 'string' ? fields.stderr : undefined,
  );
};

const runHook = (socketPath: string, event: string): void => {
  const payload = readPayload(event);
  if (payload === undefined) {
    return;
  }

  const timer = setTimeout(() => {
    fail(event, 'Tau channel did not answer within its budget.');
  }, 12_000);
  let answered = '';
  const socket = open(socketPath, (error) => {
    clearTimeout(timer);
    fail(event, `Tau worker channel is unavailable: ${error.message}`);
  });
  socket.on('data', (chunk: string) => {
    answered += chunk;
  });
  socket.once('close', () => {
    clearTimeout(timer);
    answer(event, answered);
  });

  // oxlint-disable-next-line node/no-process-env -- Claude binds its own process identity through the hook environment.
  const claudePid = Number(process.env.CLAUDE_PID);
  socket.write(
    `${JSON.stringify({
      kind: 'hook',
      event,
      payload,
      pid: process.pid,
      // A missing identity stays absent rather than unreadable, so the parent can name what is wrong.
      ...(Number.isSafeInteger(claudePid) && claudePid > 0 ? { claudePid } : {}),
    })}\n`,
  );
};

const runMcp = (socketPath: string): void => {
  const socket = open(socketPath, (error) => {
    finish(1, undefined, `Tau worker channel is unavailable: ${error.message}\n`);
  });

  socket.write(`${JSON.stringify({ kind: 'mcp', pid: process.pid, claude: process.ppid })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.once('close', () => {
    // Relayed answers are still queued for the pipe; leave only once they are written.
    if (process.stdout.writableLength === 0) {
      finish(0);

      return;
    }

    const timer = setTimeout(() => {
      finish(0);
    }, 2000);
    // A small answer never trips backpressure, so only a write callback reports the flush.
    process.stdout.write('', () => {
      clearTimeout(timer);
      finish(0);
    });
  });
};

const [mode, event, socketPath] = process.argv.slice(2);
if (mode === 'hook' && event && socketPath) {
  runHook(socketPath, event);
} else if (mode === 'mcp' && event) {
  runMcp(event);
} else {
  finish(1, undefined, `Unusable Tau channel invocation: ${process.argv.slice(2).join(' ')}\n`);
}
