import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { stopGroup } from '../src/process/process.ts';
import { isRecord } from '../src/schema.ts';
import {
  dialogResponse,
  localPackageSources,
  nextSessionState,
  openWorkers,
  piArguments,
  projectSettings,
  sessionExit,
  sessionOptions,
  startState,
} from './piSessionRules.ts';
import type {
  LocalPackage,
  PromptSource,
  SessionEnd,
  SessionOptions,
  SessionState,
} from './piSessionRules.ts';
import { createEventLog, piChildEnvironment } from './piSmokeSetup.ts';

interface Checkout {
  realPath: string;
  name: string;
}

interface WrittenSettings {
  path: string;
  createdDirectory: boolean;
}

interface Session {
  pi: string;
  model: string | undefined;
  options: SessionOptions;
  prompt: string;
  eventLog: string;
}

const usage = `Usage: node scripts/piSession.ts --cwd <directory> (--prompt <text> | --prompt-file <file>)
  [--tau <checkout>] [--pi <binary>] [--model <pattern>] [--timeout <seconds>]

Runs a headless Pi session in --cwd that loads the Tau checkout, sends one prompt, waits until each
worker it launched has reported or ended, and prints the path of the event log.

--tau defaults to this checkout. --pi defaults to the installed pi on PATH. --timeout defaults to
1800 seconds.`;

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stopGraceMilliseconds = 3000;
const millisecondsPerSecond = 1000;

class RefusalError extends Error {
  override name = 'RefusalError';
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

const packageName = (directory: string): string | undefined => {
  const manifest = readJson(join(directory, 'package.json'));

  return isRecord(manifest) && typeof manifest.name === 'string' ? manifest.name : undefined;
};

const realPath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

const readCheckout = (path: string): Checkout => {
  const resolved = realPath(path);
  const name = resolved === undefined ? undefined : packageName(resolved);

  if (resolved === undefined || name === undefined) {
    throw new RefusalError(`--tau ${path} has no package.json with a name.`);
  }

  return { realPath: resolved, name };
};

const agentDirectory = (): string => {
  // oxlint-disable-next-line node/no-process-env -- Pi reads its settings from this directory.
  const configured = process.env.PI_CODING_AGENT_DIR;

  return configured ?? join(homedir(), '.pi', 'agent');
};

const readUserPackages = (): LocalPackage[] => {
  const directory = agentDirectory();
  const sources = localPackageSources(readJson(join(directory, 'settings.json')));

  return sources.flatMap((written) => {
    const expanded = written.startsWith('~/') ? join(homedir(), written.slice(2)) : written;
    const source = resolve(directory, expanded);
    const resolved = realPath(source);

    return resolved === undefined
      ? []
      : [{ source, realPath: resolved, name: packageName(resolved) }];
  });
};

const writeSettings = (cwd: string, content: string): WrittenSettings => {
  const directory = join(cwd, '.pi');
  const path = join(directory, 'settings.json');

  if (existsSync(path)) {
    throw new RefusalError(
      `${path} already exists. Remove it, or install the checkout in the user's Pi settings.`,
    );
  }

  const createdDirectory = !existsSync(directory);

  mkdirSync(directory, { recursive: true });
  writeFileSync(path, content);

  return { path, createdDirectory };
};

const removeSettings = (written: WrittenSettings | undefined): void => {
  if (written === undefined) {
    return;
  }

  rmSync(written.path, { force: true });

  if (!written.createdDirectory) {
    return;
  }

  try {
    rmdirSync(dirname(written.path));
  } catch {
    // Pi or the session wrote other files into the directory, so it stays.
  }
};

const readPrompt = (source: PromptSource): string => {
  if (source.kind === 'text') {
    return source.text;
  }

  try {
    return readFileSync(source.path, 'utf8');
  } catch (error) {
    throw new RefusalError(`--prompt-file ${source.path} cannot be read.`, { cause: error });
  }
};

const checkWorkingDirectory = (cwd: string): void => {
  const isDirectory = statSync(cwd, { throwIfNoEntry: false })?.isDirectory() ?? false;

  if (!isDirectory) {
    throw new RefusalError(`--cwd ${cwd} is not a directory.`);
  }
};

const parseRecord = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const runPi = async (session: Session): Promise<{ end: SessionEnd; state: SessionState }> => {
  const { options, eventLog } = session;
  const sessionDirectory = mkdtempSync(join(tmpdir(), 'tau-pi-session-'));

  const child = spawn(session.pi, piArguments(sessionDirectory, session.model), {
    cwd: options.cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'inherit'],
    // oxlint-disable-next-line node/no-process-env -- the child environment starts from the caller's PATH.
    env: piChildEnvironment(process.env.PATH ?? ''),
  });

  let state = startState;
  let buffer = '';

  const { promise: ended, resolve: finish } = Promise.withResolvers<SessionEnd>();

  const receive = (line: string) => {
    const record = parseRecord(line);
    const response = dialogResponse(record);

    if (response !== undefined) {
      child.stdin.write(`${response}\n`);
    }

    state = nextSessionState(state, record);

    if (state.step.kind !== 'running') {
      finish(state.step);
    }
  };

  child.stdout.setEncoding('utf8');

  // RPC records are split only on LF, so readline's other separators would break a record.
  child.stdout.on('data', (chunk: string) => {
    appendFileSync(eventLog, chunk);
    buffer += chunk;

    const lines = buffer.split('\n');

    buffer = lines.pop() ?? '';
    lines.forEach(receive);
  });

  // Writing to a Pi that already exited fails, and the exit reports that instead.
  child.stdin.on('error', () => undefined);

  child.on('error', (error) => {
    finish({ kind: 'failed', cause: `Pi did not start: ${error.message}` });
  });

  child.on('exit', (code) => {
    finish({ kind: 'pi-exit', code });
  });

  const timer = setTimeout(() => {
    finish({ kind: 'timeout', seconds: options.timeoutSeconds });
  }, options.timeoutSeconds * millisecondsPerSecond);

  timer.unref();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      finish({ kind: 'signal', signal });
    });
  }

  child.stdin.write(
    `${JSON.stringify({ id: 'prompt', type: 'prompt', message: session.prompt })}\n`,
  );

  const end = await ended;

  child.stdin.end();
  await stopGroup(child, stopGraceMilliseconds);
  rmSync(sessionDirectory, { recursive: true, force: true });

  return { end, state };
};

const runSession = async (values: {
  tau?: string;
  pi?: string;
  model?: string;
  cwd?: string;
  prompt?: string;
  'prompt-file'?: string;
  timeout?: string;
}): Promise<number> => {
  const options = sessionOptions(values);

  if (typeof options === 'string') {
    throw new RefusalError(options);
  }

  checkWorkingDirectory(options.cwd);

  const prompt = readPrompt(options.prompt);
  const checkout = readCheckout(values.tau ?? checkoutRoot);
  const settings = projectSettings(checkout, readUserPackages());
  const written = settings === undefined ? undefined : writeSettings(options.cwd, settings);
  const eventLog = createEventLog('tau-pi-session-log-');
  const session = { pi: values.pi ?? 'pi', model: values.model, options, prompt, eventLog };

  try {
    const { end, state } = await runPi(session);
    const exit = sessionExit(end, openWorkers(state), eventLog);

    process.stdout.write(exit.output.map((line) => `${line}\n`).join(''));
    process.stderr.write(exit.errors.map((line) => `${line}\n`).join(''));

    return exit.code;
  } finally {
    removeSettings(written);
  }
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      tau: { type: 'string' },
      cwd: { type: 'string' },
      prompt: { type: 'string' },
      'prompt-file': { type: 'string' },
      pi: { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean' },
    },
  });

  if (values.help === true) {
    process.stdout.write(`${usage}\n`);

    return 0;
  }

  try {
    return await runSession(values);
  } catch (error) {
    if (!(error instanceof RefusalError)) {
      throw error;
    }

    process.stderr.write(`${error.message}\n`);

    return 1;
  }
};

process.exitCode = await main();
