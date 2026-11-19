import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { SessionManager, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import toolResultRedaction from '../src/extensions/toolResultRedaction/toolResultRedaction.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface Run {
  toolText: string;
  isError: boolean;
  sessionFile: string;
  secondRequest: string;
}

const fakeSecret = 'fake-secret-value-1234567890';
const fakeEscapedSecret = 'fake-esc\\ape"d-value-1234567890';

// The shell inherits only these, so no real credential can reach a command or a failure message.
const inheritedNames = new Set(['PATH', 'HOME', 'TMPDIR', 'SHELL', 'LANG']);

const controlEnvironment = (): void => {
  for (const name of Object.keys(process.env)) {
    if (!inheritedNames.has(name)) {
      vi.stubEnv(name, undefined);
    }
  }

  vi.stubEnv('TAU_FAKE_API_KEY', fakeSecret);
  vi.stubEnv('TAU_FAKE_ESCAPED_TOKEN', fakeEscapedSecret);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};

const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

// A file or request that holds JSON text escapes a value once more, so check three levels.
const leakedForms = [fakeSecret, fakeEscapedSecret].flatMap((value) => [
  value,
  jsonEscaped(value),
  jsonEscaped(jsonEscaped(value)),
]);

const leaks = (text: string): boolean => leakedForms.some((form) => text.includes(form));

const runSession = async (
  toolCall: ReturnType<typeof fauxToolCall>,
  tools: string[],
): Promise<Run> => {
  controlEnvironment();
  const directory = temporaryDirectory(onTestFinished, 'tau-redaction-');
  const provider = fauxProvider({ provider: 'tau-redaction' });
  const sessionManager = SessionManager.create(directory, join(directory, 'sessions'));

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools,
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    sessionManager,
    extensionFactories: [toolResultRedaction, createCodemodeExtension({ mode: 'on' })],
  });

  let toolText = '';
  let isError = false;
  let secondRequest = '';

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === toolCall.name) {
      const result = event.result as { content: { type: string; text?: string }[] };

      toolText = result.content.map((block) => block.text ?? '').join('');
      isError = event.isError;
    }
  });

  provider.setResponses([
    fauxAssistantMessage([toolCall]),
    (context) => {
      secondRequest = JSON.stringify(context);

      return fauxAssistantMessage('Done.');
    },
  ]);

  await session.prompt('Run the command.');

  const sessionPath = sessionManager.getSessionFile() ?? '';

  return { toolText, isError, sessionFile: readFileSync(sessionPath, 'utf8'), secondRequest };
};

const bash = (command: string) => fauxToolCall('bash', { command });

// A file or request stores the text as a JSON string, so it holds the assignment escaped once.
const storedForm = (text: string): string => jsonEscaped(text);

it.each([
  { command: 'env | grep -E "PI_"', assignment: 'TAU_FAKE_API_KEY=[redacted]' },
  { command: 'printenv', assignment: 'TAU_FAKE_API_KEY=[redacted]' },
  { command: 'set', assignment: 'TAU_FAKE_API_KEY=[redacted]' },
  {
    command: `node -e 'console.log(JSON.stringify(process.env))'`,
    assignment: '"TAU_FAKE_API_KEY":"[redacted]"',
  },
])('redacts the fake secret from the bash result of $command', async ({ command, assignment }) => {
  const run = await runSession(bash(command), ['bash']);

  expect(run.toolText.includes(assignment)).toBe(true);
  expect(leaks(run.toolText)).toBe(false);
  expect(run.sessionFile.includes(storedForm(assignment))).toBe(true);
  expect(leaks(run.sessionFile)).toBe(false);
  expect(run.secondRequest.includes(storedForm(assignment))).toBe(true);
  expect(leaks(run.secondRequest)).toBe(false);
  expect(process.env.TAU_FAKE_API_KEY === fakeSecret).toBe(true);
});

it('redacts a value that JSON.stringify of the environment escapes', async () => {
  const command = `node -e 'console.log(JSON.stringify(process.env))'`;
  const assignment = '"TAU_FAKE_ESCAPED_TOKEN":"[redacted]"';

  const run = await runSession(bash(command), ['bash']);

  expect(run.toolText.includes(assignment)).toBe(true);
  expect(leaks(run.toolText)).toBe(false);
  expect(run.sessionFile.includes(storedForm(assignment))).toBe(true);
  expect(leaks(run.sessionFile)).toBe(false);
  expect(run.secondRequest.includes(storedForm(assignment))).toBe(true);
  expect(leaks(run.secondRequest)).toBe(false);
});

it('redacts the fake secret from a failing bash result and keeps the error flag', async () => {
  const run = await runSession(bash('printenv TAU_FAKE_API_KEY; exit 1'), ['bash']);

  expect(run.isError).toBe(true);
  expect(run.toolText.includes('[redacted]')).toBe(true);
  expect(leaks(run.toolText)).toBe(false);
  expect(leaks(run.sessionFile)).toBe(false);
  expect(leaks(run.secondRequest)).toBe(false);
});

it('redacts the fake secret from the output a codemode script receives', async () => {
  const code = [
    "const result = await tools.bash({ command: 'printenv TAU_FAKE_API_KEY' });",
    'return result.output;',
  ].join('\n');

  const run = await runSession(fauxToolCall('codemode', { code }), ['bash', 'codemode']);

  expect(run.toolText.includes('[redacted]')).toBe(true);
  expect(leaks(run.toolText)).toBe(false);
  expect(leaks(run.sessionFile)).toBe(false);
  expect(leaks(run.secondRequest)).toBe(false);
});
