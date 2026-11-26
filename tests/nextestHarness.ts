import { execFile } from 'node:child_process';
import { appendFile, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { beforeAll, expect, vi } from 'vitest';

import { parseCargoMetadata } from '../src/extensions/tdd/runner/cargoMetadata.js';
import { targetArguments } from '../src/extensions/tdd/runner/nextestArguments.js';
import type { RunnerResult } from '../src/extensions/tdd/runner/types.js';
import tddExtension from '../src/extensions/tdd/tdd.js';
import type { ObservationResult } from '../src/extensions/tdd/types.js';
import { fakeExtensionApi } from './extensionApi.js';
import { writeFileMap } from './fileMap.js';
import { suiteCleanup, temporaryDirectory } from './temporaryDirectoryHarness.js';

export interface NextestToolResult {
  content: { type: 'text'; text: string }[];
  details: ObservationResult;
}

export interface NextestRequest {
  behavior?: string;
  testFullName: string | string[];
  files: string[];
  scope?: 'focused' | 'full';
}

export interface NextestPatch {
  content: { type: 'text'; text: string }[];
}

export interface NextestTool {
  run: (cwd: string, request: NextestRequest) => Promise<NextestToolResult>;
  edit: (cwd: string, path: string, content: string) => Promise<NextestPatch | undefined>;
}

export const nextestConfig = JSON.stringify({ tdd: { runner: 'nextest' } });

// A toMatchObject failure prints only the keys the expectation names, so the reason has to travel as
// the assertion message. The runner's message starts at the first error line, and a run stage carries
// no output in its message, so the stage excerpts follow.
export const stageOutput = (result: RunnerResult): string => {
  const message = 'message' in result ? result.message : '';

  const stages = (result.diagnostics?.stages ?? []).map(
    (stage) => `${stage.name}: exit ${stage.exitCode ?? 'unavailable'}\n${stage.excerpt ?? ''}`,
  );

  return [message, ...stages].filter((part) => part !== '').join('\n\n');
};

export const expectOutcome = (report: RunnerResult, expected: Record<string, unknown>): void => {
  expect(report, stageOutput(report)).toMatchObject(expected);
};

export const createCrate = async (
  cleanup: Parameters<typeof temporaryDirectory>[0],
  name: string,
  files: Record<string, string>,
): Promise<string> => {
  const directory = temporaryDirectory(cleanup, `tau-nextest-${name}-`);

  await writeFileMap(directory, files);

  return directory;
};

export const cargoPackage = (name: string): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;

export const libraryWith = (body: string): string => `#[cfg(test)]\nmod tests {\n${body}\n}\n`;

// One target directory per test file keeps the crates from recompiling each other, and a fresh
// agent directory keeps the developer's Tau config out of the run.
export const useSharedCargoEnvironment = (prefix: string): void => {
  const registerCleanup = suiteCleanup();
  let previousTargetDirectory: string | undefined;
  let previousAgentDirectory: string | undefined;

  beforeAll(() => {
    previousTargetDirectory = process.env.CARGO_TARGET_DIR;
    previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.CARGO_TARGET_DIR = temporaryDirectory(registerCleanup, `tau-${prefix}-target-`);
    process.env.PI_CODING_AGENT_DIR = temporaryDirectory(registerCleanup, `tau-${prefix}-agent-`);
  });

  registerCleanup(() => {
    if (previousTargetDirectory === undefined) {
      delete process.env.CARGO_TARGET_DIR;
    } else {
      process.env.CARGO_TARGET_DIR = previousTargetDirectory;
    }

    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
  });
};

export const prebuildCrate = async (cwd: string): Promise<void> => {
  const metadata = await promisify(execFile)(
    'cargo',
    ['metadata', '--no-deps', '--format-version', '1'],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );

  const parsed = parseCargoMetadata(metadata.stdout);

  if (parsed === null) {
    throw new Error('Could not read cargo metadata for the prebuild.');
  }

  await promisify(execFile)(
    'cargo',
    ['nextest', 'list', ...targetArguments(parsed), '--message-format', 'json'],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );
};

// Cargo keeps a binary and its dep-info file in debug/deps, or in debug/build/<package>/<hash>/out
// with cargo 1.100.0, so this searches the whole debug folder.
export const removeDepInfoFiles = async (packageName: string): Promise<void> => {
  const targetDirectory = process.env.CARGO_TARGET_DIR;

  if (targetDirectory === undefined) {
    throw new Error('CARGO_TARGET_DIR is not set; call useSharedCargoEnvironment first.');
  }

  const buildDirectory = join(targetDirectory, 'debug');
  const entries = await readdir(buildDirectory, { recursive: true });

  const depInfo = entries.filter((entry) => {
    const fileName = basename(entry);

    return fileName.startsWith(`${packageName}-`) && fileName.endsWith('.d');
  });

  if (depInfo.length === 0) {
    throw new Error(`Found no dep-info files for ${packageName} in ${buildDirectory}.`);
  }

  await Promise.all(depInfo.map((entry) => rm(join(buildDirectory, entry))));
};

export const createNextestTool = (): NextestTool => {
  const fake = fakeExtensionApi();
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  tddExtension(fake.pi);

  const tool = fake.tools.get('run_tests');

  if (tool === undefined) {
    throw new Error('Missing run_tests tool');
  }

  const contextFor = (cwd: string) =>
    ({
      cwd,
      hasUI: false,
      ui: { notify },
      isProjectTrusted: () => true,
    }) as unknown as ExtensionContext & ExtensionToolContext;

  const run = async (cwd: string, request: NextestRequest): Promise<NextestToolResult> => {
    const parameters = {
      behavior: request.behavior ?? 'behavior',
      testFullName: request.testFullName,
      files: request.files,
      scope: request.scope ?? 'focused',
    };

    const result = await tool.execute('run', parameters, undefined, undefined, contextFor(cwd));

    return result as NextestToolResult;
  };

  const edit = async (
    cwd: string,
    path: string,
    content: string,
  ): Promise<NextestPatch | undefined> => {
    await appendFile(join(cwd, path), content);

    const result = await fake.handler('tool_result')(
      {
        toolName: 'write',
        input: { path },
        isError: false,
        content: [{ type: 'text', text: 'Original result' }],
      },
      contextFor(cwd),
    );

    return result as NextestPatch | undefined;
  };

  return { run, edit };
};
