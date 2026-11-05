import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type {
  FauxResponseStep,
  ImageContent,
  TextContent,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../../errors.js';
import { parseAnswerReference } from '../answerRecord.js';

interface FixtureAssignment {
  task: string;
  loadout: { instructions: string };
}

export const questionTaskMarker = 'fixture-asks-the-manager';

export const firstTaskMarker = 'fixture-first-task-marker';

export const followUpTaskMarker = 'fixture-follow-up-marker';

const fixtureQuestion = 'Which value should the report hold?';

const fixtureSummary =
  'Model-free CLI fixture completed.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None';

const readFixtureAssignment = (): FixtureAssignment | undefined => {
  const hcSession = process.env.HC_SESSION;

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
  } catch (error) {
    throw new Error(
      `controlledProvider could not read the fixture assignment: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
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

const appendSystemText = (): string | undefined => {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR;

  if (agentDirectory === undefined || agentDirectory === '') {
    return undefined;
  }

  try {
    return readFileSync(join(agentDirectory, 'APPEND_SYSTEM.md'), 'utf8').trim();
  } catch {
    return undefined;
  }
};

const appendSystemPresent = (context: TranscriptContext): boolean => {
  const text = appendSystemText();

  return (
    text !== undefined && text !== '' && getCurrentSystemPrompt(context.messages).includes(text)
  );
};

const isTextBlock = (block: TextContent | ImageContent): block is TextContent =>
  block.type === 'text';

const contentText = (content: string | (TextContent | ImageContent)[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n');

// The answer message carries a reference to the answer file, not the answer text.
const deliveredAnswer = (context: TranscriptContext): string => {
  const userMessages = context.messages.filter((message) => message.role === 'user');
  const message = userMessages.at(-1);

  if (userMessages.length < 2 || message === undefined) {
    throw new Error('The fixture question got no answer message from the manager.');
  }

  const reference = parseAnswerReference(contentText(message.content).trim());
  const record = JSON.parse(readFileSync(reference.answerPath, 'utf8')) as { answer?: unknown };

  if (typeof record.answer !== 'string' || record.answer === '') {
    throw new Error(`The fixture answer file has no answer: ${reference.answerPath}.`);
  }

  return record.answer;
};

const asksTheManager = (): boolean => savedAssignment?.task.includes(questionTaskMarker) ?? false;

const firstTaskPresent = (context: TranscriptContext): boolean => {
  const text = context.messages
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .join('\n');

  return text.includes(firstTaskMarker);
};

const followUpResponses = (): FauxResponseStep[] => [
  (context) => {
    const present = firstTaskPresent(context);

    return fauxAssistantMessage([
      fauxToolCall('subagent_report', {
        outcome: present ? 'success' : 'failure',
        summary: fixtureSummary,
        evidence: [`first task in context: ${present}`],
      }),
    ]);
  },
];

const questionResponses = (): FauxResponseStep[] => [
  fauxAssistantMessage([fauxToolCall('subagent_question', { question: fixtureQuestion })]),
  (context) =>
    fauxAssistantMessage([
      fauxToolCall('subagent_report', {
        outcome: 'success',
        summary: fixtureSummary,
        evidence: [deliveredAnswer(context)],
      }),
    ]),
];

const reportResponses = (): FauxResponseStep[] => [
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
    const appendPresent = appendSystemPresent(context);

    return fauxAssistantMessage([
      fauxToolCall('subagent_report', {
        outcome: blocked && edited && instructions ? 'success' : 'failure',
        summary: fixtureSummary,
        evidence: [
          'edit checked',
          `Safety Net block: ${blocked}`,
          `saved instructions: ${instructions}`,
          `PATH: ${process.env.PATH ?? ''}`,
          `PI_CODING_AGENT_DIR: ${process.env.PI_CODING_AGENT_DIR ?? ''}`,
          `TAU_ROLE: ${process.env.TAU_ROLE ?? ''}`,
          `APPEND_SYSTEM.md: ${appendPresent}`,
        ],
      }),
    ]);
  },
];

const fixtureResponses = (): FauxResponseStep[] => {
  if (savedAssignment?.task.includes(followUpTaskMarker) ?? false) {
    return followUpResponses();
  }

  return asksTheManager() ? questionResponses() : reportResponses();
};

export default function controlledProvider(pi: ExtensionAPI): void {
  provider.setResponses(fixtureResponses());

  pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
}
