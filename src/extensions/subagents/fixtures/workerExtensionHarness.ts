import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { onTestFinished, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../../tests/extensionApi.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { skillTools } from '../../../skillTools.js';
import { assignmentDirectory } from '../assignment.js';
import type { Assignment } from '../assignment.js';
import type { Loadout } from '../types.js';
import workerExtension from '../workerExtension.js';
import { workerStartMessage } from '../workerStart.js';
import { workerTools } from '../workerTools.js';
import { fixtureLoadout } from './loadout.js';

interface WorkerExtensionSetup {
  activeTools: Mock<(names: string[]) => void>;
  assignmentPath: string;
  context: ExtensionToolContext;
  directory: string;
  loadout: Loadout;
  pi: ReturnType<typeof fakeExtensionApi>;
  shutdown: Mock<ExtensionContext['shutdown']>;
  tools: string[];
}

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const sessionId = '11111111-1111-1111-1111-111111111111';

const safetyPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

export const setup = (assignmentPath?: string): WorkerExtensionSetup => {
  const directory = realpathSync(temporaryDirectory(onTestFinished, 'tau-worker-extension-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  const loadout = fixtureLoadout(directory);
  const tools = workerTools(loadout, skillTools);
  const fake = createHcFake();
  const path = assignmentPath ?? join(assignmentDirectory(assignmentId), 'assignment.json');

  fake.reply(
    'get',
    JSON.stringify({
      address: workerTerminal,
      state: 'live',
      parent: parentTerminal,
      labels: { 'tau.assignment': path },
    }),
  );

  const activeTools = vi.fn<(names: string[]) => void>();

  const pi = fakeExtensionApi({
    exec: fake.exec,
    getThinkingLevel: () => 'off',
    getCommands: () => [
      { name: 'cc-safety-net', source: 'extension', sourceInfo: { path: safetyPath } },
    ],
    getAllTools: () => tools.map((name) => ({ name })),
    setActiveTools: activeTools,
  } as unknown as Partial<ExtensionAPI>);

  const shutdown = vi.fn<ExtensionContext['shutdown']>();

  const context = {
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => sessionId,
      getSessionFile: () => join(directory, `${sessionId}.jsonl`),
    },
    shutdown,
    cwd: directory,
    model: { provider: 'faux', id: 'test' },
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: { notify: vi.fn<ExtensionToolContext['ui']['notify']>() },
  } as unknown as ExtensionToolContext;

  workerExtension(pi.pi);

  return { activeTools, assignmentPath: path, context, directory, loadout, pi, shutdown, tools };
};

export const assignmentFor = (directory: string): Assignment => ({
  version: 3,
  assignmentId,
  task: 'Inspect the fixture.',
  acceptance: [],
  label: null,
  profile: 'worker',
  loadout: fixtureLoadout(directory),
  routing: null,
  packageSnapshot: null,
  session: {
    id: sessionId,
    file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`),
  },
  parentSession: join(directory, 'parent.jsonl'),
  cwd: directory,
  parentTerminal,
  deadline: Date.now() + 60_000,
  createdAt: Date.now(),
  previousAssignmentId: null,
  extensionPackages: null,
  questions: [],
  report: null,
});

export const sendStartMessage = (
  pi: ReturnType<typeof setup>['pi'],
  context: ExtensionToolContext,
): Promise<unknown> =>
  Promise.resolve(
    pi.handler('input')(
      { type: 'input', text: workerStartMessage, source: 'interactive' },
      context,
    ),
  );

export const dispatch = (
  pi: ReturnType<typeof setup>['pi'],
  name: string,
  event: unknown,
  context: ExtensionContext,
): void => {
  for (const handler of pi.handlers.get(name) ?? []) {
    handler(event as never, context);
  }
};
