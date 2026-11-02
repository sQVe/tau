import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

interface FixtureAssignment {
  loadout: { instructions: string };
}

// The worker reads its assignment from its own `hc` terminal, as the worker extension does. The
// fixture reads the same file so its report reflects the saved instructions.
const readFixtureAssignment = (): FixtureAssignment | undefined => {
  const hcSession = process.env.HC_SESSION;

  // Never guess at the user's default core: only a private test session may be reached.
  if (hcSession === undefined || hcSession === '') {
    throw new Error('controlledProvider needs HC_SESSION; refusing to reach the default hc core.');
  }

  const address = process.env.HC_TERMINAL_ID;

  if (address === undefined || address === '') {
    return undefined;
  }

  try {
    const output = execFileSync('hc', ['get', '--json', '--', address], {
      encoding: 'utf8',
      env: process.env,
    });

    const terminal = JSON.parse(output) as { labels?: Record<string, string> };
    const path = terminal.labels?.['tau.assignment'];

    if (path === undefined || path === '') {
      return undefined;
    }

    return JSON.parse(readFileSync(path, 'utf8')) as FixtureAssignment;
  } catch {
    return undefined;
  }
};

const savedAssignment = readFixtureAssignment();

const provider = fauxProvider({ provider: 'tau-worker-fixture', api: 'tau-worker-fixture' });

export const fixtureModel = provider.getModel();

export const fixtureAuth = {
  apiKey: {
    name: 'Fixture',
    resolve: (): Promise<{ auth: { apiKey: string } }> =>
      Promise.resolve({ auth: { apiKey: 'fixture-key-not-a-secret' } }),
  },
};

const systemInstructions = (context: TranscriptContext): boolean =>
  savedAssignment !== undefined &&
  getCurrentSystemPrompt(context.messages).includes(savedAssignment.loadout.instructions);

export default function controlledProvider(pi: ExtensionAPI): void {
  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall('edit', {
        path: 'source.txt',
        edits: [{ oldText: 'before', newText: 'after' }],
      }),
    ]),
    fauxAssistantMessage([
      fauxToolCall('bash', { command: 'test "$(cat source.txt)" = after && printf command-ok' }),
      fauxToolCall('bash', { command: 'find ./delete-fixture/.git -delete' }),
    ]),
    (context) => {
      const blocked = context.messages.some(
        (message) =>
          message.role === 'toolResult' &&
          JSON.stringify(message.content).includes('BLOCKED by CC Safety Net'),
      );

      const edited = readFileSync(`${process.cwd()}/source.txt`, 'utf8') === 'after\n';
      const instructions = systemInstructions(context);

      return fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: blocked && edited && instructions ? 'success' : 'failure',
          summary:
            'Model-free CLI fixture completed.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
          evidence: [
            'edit checked',
            `Safety Net block: ${blocked}`,
            `saved instructions: ${instructions}`,
          ],
        }),
      ]);
    },
  ]);

  pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
}
