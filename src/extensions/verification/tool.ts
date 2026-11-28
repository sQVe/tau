import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { readConfigLocation } from '../../config/config.js';
import type { RunRecord } from '../../verification/records.js';
import { launchRun } from './launchAction.js';
import type { LaunchResult } from './launchAction.js';
import { registerItems } from './registerAction.js';
import type { RegisterResult } from './registerAction.js';
import {
  checkRecordDirectory,
  checkRecordSymlinks,
  findRunDirectory,
  findVerificationRoots,
} from './runDirectory.js';
import { readRunFacts, readTarget, requireRunRecordFile } from './runFacts.js';
import { stopRun } from './stopAction.js';
import type { StopResult } from './stopAction.js';

type RegisteredItem = RunRecord['items'][number];

export interface VerificationToolOptions {
  agentDirectory?: string;
  deadlineMilliseconds?: number;
}

export type VerificationDetails = LaunchResult | RegisterResult | StopResult;

type ParsedAction =
  | { action: 'launch'; target: string }
  | { action: 'register'; run: string; items: RegisteredItem[] }
  | { action: 'stop'; run: string };

const millisecondsPerMinute = 60_000;
const defaultDeadlineMinutes = 5;
const defaultDeadlineMilliseconds = defaultDeadlineMinutes * millisecondsPerMinute;

const parameters = Type.Object({
  action: Type.Union([Type.Literal('launch'), Type.Literal('register'), Type.Literal('stop')]),
  target: Type.Optional(Type.String({ minLength: 1 })),
  run: Type.Optional(Type.String({ minLength: 1 })),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        item: Type.String({ minLength: 1 }),
        steps: Type.Integer({ minimum: 1 }),
      }),
    ),
  ),
});

const description = `Manage a verification run in the shared root's .tau/verification/<run>/run.json. Config, commands, and tree stay on the checkout.
- launch: run the target's launch and doctor commands. Needs target. Returns ready with run and directory, or failed with command, exitCode, logPath, stopped. A stopped launch runs stop; if it fails, call stop again. A failed launch or doctor runs no stop and returns stopped false; call stop.
- register: add items to a ready run. Needs run and items, each {item, steps}. Returns run, directory, items. Refuses a stopped run or one without a passing doctor.
- stop: run the target's stop command in the checkout that launched it and keep the folder. Needs run. Returns stopped, run, directory, exitCode, logPath, freshness (notStopped when the stop fails). stopped false keeps it open; call stop again. A stopped run stays stopped if freshness is false.`;

const parseAction = (input: Static<typeof parameters>): ParsedAction => {
  if (input.action === 'launch') {
    if (input.run !== undefined) {
      throw new Error('launch does not take run.');
    }

    if (input.items !== undefined) {
      throw new Error('launch does not take items.');
    }

    if (input.target === undefined) {
      throw new Error('launch needs target.');
    }

    return { action: 'launch', target: input.target };
  }

  if (input.action === 'register') {
    if (input.target !== undefined) {
      throw new Error('register does not take target.');
    }

    if (input.run === undefined) {
      throw new Error('register needs run.');
    }

    if (input.items === undefined) {
      throw new Error('register needs items.');
    }

    return { action: 'register', run: input.run, items: input.items };
  }

  if (input.target !== undefined) {
    throw new Error('stop does not take target.');
  }

  if (input.items !== undefined) {
    throw new Error('stop does not take items.');
  }

  if (input.run === undefined) {
    throw new Error('stop needs run.');
  }

  return { action: 'stop', run: input.run };
};

const toToolResult = (details: VerificationDetails) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(details) }],
  details,
});

const execute = async (
  options: VerificationToolOptions,
  input: Static<typeof parameters>,
  signal: AbortSignal | undefined,
  context: Pick<ExtensionToolContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
) => {
  const parsed = parseAction(input);
  const deadlineMilliseconds = options.deadlineMilliseconds ?? defaultDeadlineMilliseconds;

  if (parsed.action === 'launch') {
    const { checkoutRoot, recordRoot } = await findVerificationRoots(context.cwd, 'verification');
    const location = readConfigLocation(checkoutRoot, options, context);
    const commands = readTarget(location, context.ui, parsed.target);
    const facts = await readRunFacts(checkoutRoot);

    const details = await launchRun({
      checkoutRoot,
      recordRoot,
      deadlineMilliseconds,
      signal,
      target: parsed.target,
      commands,
      facts,
    });

    return toToolResult(details);
  }

  const { checkoutRoot, recordRoot, directory } = await findRunDirectory(
    context.cwd,
    parsed.run,
    'verification',
  );

  await checkRecordSymlinks(recordRoot, directory);
  await requireRunRecordFile(directory, parsed.run);
  await checkRecordDirectory(recordRoot, directory);

  if (parsed.action === 'register') {
    const details = await registerItems(
      {
        directory,
        deadlineMilliseconds,
        signal,
        run: parsed.run,
      },
      parsed.items,
    );

    return toToolResult(details);
  }

  const location = readConfigLocation(checkoutRoot, options, context);

  const details = await stopRun({
    checkoutRoot,
    directory,
    deadlineMilliseconds,
    signal,
    run: parsed.run,
    readTarget: (name) => readTarget(location, context.ui, name),
  });

  return toToolResult(details);
};

export const createVerificationTool = (
  options: VerificationToolOptions = {},
): ToolDefinition<typeof parameters, VerificationDetails> =>
  defineTool({
    name: 'verification',
    label: 'Verification',
    description,
    promptSnippet: 'Launch, register items on, and stop a verification run.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      return execute(options, input, signal, context);
    },
  });
