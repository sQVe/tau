import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface DecisionRow {
  name: string;
  terminalId: string;
  scope: string;
  guard: string;
  read: string;
  sessionLabel: string;
  cwdLabel: string;
  recordedPid: string;
  currentPid: string;
  sessionFileExists: string;
  cwdExists: string;
  piAvailable: string;
  decision: 'skip' | 'retry' | 'resume';
}

interface ShellCase {
  name: string;
  terminalId: string;
  scope: string;
  guard: string;
  labels: 'session' | 'none';
  pidMode: 'match' | 'different' | 'empty' | 'empty-then-match';
  sessionExists: boolean;
  cwdExists: boolean;
  delay: string;
  waitSeconds: string;
  pi: boolean;
  getCalls: number | undefined;
  maxElapsedMs: number | undefined;
  firstCallFailure?: 'exit' | 'malformed';
}

interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  sessionFile: string;
  cwd: string;
  piArgs: string | undefined;
  piCwd: string | undefined;
  hcCalls: number;
}

const snippetPath = fileURLToPath(new URL('./resume-pi.zsh', import.meta.url));
const decisionPath = fileURLToPath(new URL('./resume-pi-decision.zsh', import.meta.url));

const hasZsh = spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0;

const decisionRows: DecisionRow[] = [
  {
    name: 'skips without an hc terminal id',
    terminalId: '',
    scope: 'core-1',
    guard: '',
    read: '0',
    sessionLabel: '',
    cwdLabel: '',
    recordedPid: '',
    currentPid: '100',
    sessionFileExists: '0',
    cwdExists: '0',
    piAvailable: '0',
    decision: 'skip',
  },
  {
    name: 'skips when the guard names this terminal and core',
    terminalId: 't7',
    scope: 'core-1',
    guard: 'core-1/t7',
    read: '0',
    sessionLabel: '',
    cwdLabel: '',
    recordedPid: '',
    currentPid: '100',
    sessionFileExists: '0',
    cwdExists: '0',
    piAvailable: '0',
    decision: 'skip',
  },
  {
    name: 'asks for a read before the hc facts are known',
    terminalId: 't7',
    scope: 'core-1',
    guard: 'core-1/other',
    read: '0',
    sessionLabel: '',
    cwdLabel: '',
    recordedPid: '',
    currentPid: '100',
    sessionFileExists: '0',
    cwdExists: '0',
    piAvailable: '0',
    decision: 'retry',
  },
  {
    name: 'skips when there is no session label',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '',
    cwdLabel: '/work',
    recordedPid: '100',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '1',
    piAvailable: '1',
    decision: 'skip',
  },
  {
    name: 'retries while the core has not recorded a pid',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '/work',
    recordedPid: '',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '1',
    piAvailable: '1',
    decision: 'retry',
  },
  {
    name: 'skips when the recorded pid is another process',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '/work',
    recordedPid: '200',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '1',
    piAvailable: '1',
    decision: 'skip',
  },
  {
    name: 'skips when the session file is missing',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '/work',
    recordedPid: '100',
    currentPid: '100',
    sessionFileExists: '0',
    cwdExists: '1',
    piAvailable: '1',
    decision: 'skip',
  },
  {
    name: 'skips when the cwd label is empty',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '',
    recordedPid: '100',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '1',
    piAvailable: '1',
    decision: 'skip',
  },
  {
    name: 'skips when the cwd is missing',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '/work',
    recordedPid: '100',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '0',
    piAvailable: '1',
    decision: 'skip',
  },
  {
    name: 'skips when pi is unavailable',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '/work',
    recordedPid: '100',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '1',
    piAvailable: '0',
    decision: 'skip',
  },
  {
    name: 'resumes when every fact is ready',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    read: '1',
    sessionLabel: '/sessions/a.jsonl',
    cwdLabel: '/work',
    recordedPid: '100',
    currentPid: '100',
    sessionFileExists: '1',
    cwdExists: '1',
    piAvailable: '1',
    decision: 'resume',
  },
];

const decide = (row: DecisionRow): string => {
  const values = [
    row.terminalId,
    row.scope,
    row.guard,
    row.read,
    row.sessionLabel,
    row.cwdLabel,
    row.recordedPid,
    row.currentPid,
    row.sessionFileExists,
    row.cwdExists,
    row.piAvailable,
  ];

  const command = `source ${JSON.stringify(decisionPath)}; _tau_resume_decision ${values
    .map((value) => JSON.stringify(value))
    .join(' ')}`;

  const result = spawnSync('zsh', ['-f', '-c', command], { encoding: 'utf8' });

  return result.stdout.trim();
};

const fakeHc = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HC_LOG"
if [ -n "$FAKE_HC_DELAY" ]; then
  sleep "$FAKE_HC_DELAY"
fi

counter=0
if [ -f "$FAKE_HC_COUNTER" ]; then
  counter=$(cat "$FAKE_HC_COUNTER")
fi
counter=$((counter + 1))
printf '%s' "$counter" > "$FAKE_HC_COUNTER"

if [ "$counter" -eq 1 ]; then
  case "$FAKE_HC_FIRST_CALL_FAILURE" in
    exit) exit 1 ;;
    malformed) printf '%s\n' 'not json'; exit 0 ;;
  esac
fi

case "$FAKE_HC_PID_MODE" in
  match) pid="$EXPECTED_SHELL_PID" ;;
  different) pid=$((EXPECTED_SHELL_PID + 1)) ;;
  empty-then-match)
    if [ "$counter" -le 1 ]; then
      pid=''
    else
      pid="$EXPECTED_SHELL_PID"
    fi
    ;;
  *) pid='' ;;
esac

if [ "$FAKE_HC_LABELS" = 'session' ]; then
  labels="{\\"pi.session\\":\\"$FAKE_HC_SESSION\\",\\"pi.cwd\\":\\"$FAKE_HC_CWD\\"}"
else
  labels='{}'
fi

if [ -n "$pid" ]; then
  printf '{"address":"%s","state":"live","pid":%s,"labels":%s}\\n' "$HC_TERMINAL_ID" "$pid" "$labels"
else
  printf '{"address":"%s","state":"live","pid":null,"labels":%s}\\n' "$HC_TERMINAL_ID" "$labels"
fi
`;

const fakePi = `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_PI_ARGS_FILE"
pwd > "$FAKE_PI_CWD_FILE"
exit 0
`;

const shellCases: ShellCase[] = [
  {
    name: 'resumes and returns to the shell',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'match',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '',
    pi: true,
    getCalls: 1,
    maxElapsedMs: undefined,
  },
  {
    name: 'skips when the guard already names this terminal',
    terminalId: 't7',
    scope: 'core-1',
    guard: 'core-1/t7',
    labels: 'session',
    pidMode: 'match',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '',
    pi: false,
    getCalls: 0,
    maxElapsedMs: undefined,
  },
  {
    name: 'skips when the pid is a different process',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'different',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '',
    pi: false,
    getCalls: 1,
    maxElapsedMs: undefined,
  },
  {
    name: 'shares one deadline across slow empty-pid replies',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'empty',
    sessionExists: true,
    cwdExists: true,
    delay: '0.7',
    waitSeconds: '1',
    pi: false,
    getCalls: undefined,
    maxElapsedMs: 1100,
  },
  {
    name: 'falls back to four seconds for an invalid wait value',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'match',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '1/0',
    pi: true,
    getCalls: 1,
    maxElapsedMs: 2500,
  },
  {
    name: 'caps a huge wait value instead of retrying for a long time',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'empty',
    sessionExists: true,
    cwdExists: true,
    delay: '0.4',
    waitSeconds: '1000000000',
    pi: false,
    getCalls: undefined,
    maxElapsedMs: 5500,
  },
  {
    name: 'resumes soon after the core records the pid',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'empty-then-match',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '',
    pi: true,
    getCalls: 2,
    maxElapsedMs: 240,
  },
  {
    name: 'retries when hc get exits non-zero once, then resumes',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'match',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '',
    firstCallFailure: 'exit',
    pi: true,
    getCalls: 2,
    maxElapsedMs: undefined,
  },
  {
    name: 'retries when hc get prints invalid JSON once, then resumes',
    terminalId: 't7',
    scope: 'core-1',
    guard: '',
    labels: 'session',
    pidMode: 'match',
    sessionExists: true,
    cwdExists: true,
    delay: '',
    waitSeconds: '',
    firstCallFailure: 'malformed',
    pi: true,
    getCalls: 2,
    maxElapsedMs: undefined,
  },
];

const writeExecutable = (path: string, contents: string): void => {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
};

const runCase = (row: ShellCase): ShellResult => {
  const root = mkdtempSync(join(tmpdir(), 'tau-resume-shell-'));

  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'hc'), fakeHc);
    writeExecutable(join(bin, 'pi'), fakePi);

    const zdotdir = join(root, 'zdotdir');
    mkdirSync(zdotdir);

    const sessionFile = join(root, 'session.jsonl');

    if (row.sessionExists) {
      writeFileSync(sessionFile, '{}\n');
    }

    const cwd = join(root, 'work');

    if (row.cwdExists) {
      mkdirSync(cwd);
    }

    const hcLog = join(root, 'hc.log');
    const hcCounter = join(root, 'hc.counter');
    const piArgsFile = join(root, 'pi.args');
    const piCwdFile = join(root, 'pi.cwd');
    const command = `export EXPECTED_SHELL_PID=$$; source ${JSON.stringify(snippetPath)}; printf 'AFTER\\n'; if (( $+functions[_tau_resume_decision] )); then printf 'HELPER_LEAK\\n'; fi`;
    const started = performance.now();

    const result = spawnSync('zsh', ['-c', command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: zdotdir,
        HC_TERMINAL_ID: row.terminalId,
        HC_SCOPE: row.scope,
        TAU_RESUME_PI_DONE: row.guard,
        TAU_RESUME_WAIT_SECONDS: row.waitSeconds,
        FAKE_HC_LOG: hcLog,
        FAKE_HC_COUNTER: hcCounter,
        FAKE_HC_PID_MODE: row.pidMode,
        FAKE_HC_LABELS: row.labels,
        FAKE_HC_SESSION: sessionFile,
        FAKE_HC_CWD: cwd,
        FAKE_HC_DELAY: row.delay,
        FAKE_HC_FIRST_CALL_FAILURE: row.firstCallFailure ?? '',
        FAKE_PI_ARGS_FILE: piArgsFile,
        FAKE_PI_CWD_FILE: piCwdFile,
      },
      timeout: 20_000,
    });

    const elapsedMs = performance.now() - started;

    const hcCalls = existsSync(hcLog)
      ? readFileSync(hcLog, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line !== '').length
      : 0;

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs,
      sessionFile,
      cwd,
      piArgs: existsSync(piArgsFile) ? readFileSync(piArgsFile, 'utf8').trim() : undefined,
      piCwd: existsSync(piCwdFile) ? readFileSync(piCwdFile, 'utf8').trim() : undefined,
      hcCalls,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe.skipIf(!hasZsh)('resume-pi shell snippet', () => {
  it.each(decisionRows)('$name', (row) => {
    expect(decide(row)).toBe(row.decision);
  });

  it.each(shellCases)('$name', (row) => {
    const result = runCase(row);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AFTER');
    expect(result.stdout).not.toContain('HELPER_LEAK');
    expect(result.piArgs).toBe(row.pi ? `--session ${result.sessionFile}` : undefined);
    expect(result.piCwd).toBe(row.pi ? result.cwd : undefined);
    const hcCallsToCheck = row.getCalls === undefined ? undefined : result.hcCalls;

    expect(hcCallsToCheck, result.stderr).toBe(row.getCalls);
    expect(result.elapsedMs).toBeLessThan(row.maxElapsedMs ?? Number.POSITIVE_INFINITY);
  });
});
