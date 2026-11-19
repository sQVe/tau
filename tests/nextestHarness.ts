import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { beforeAll, vi } from 'vitest';

import { parseCargoMetadata } from '../src/extensions/tdd/runner/cargoMetadata.js';
import { targetArguments } from '../src/extensions/tdd/runner/nextestArguments.js';
import tddExtension from '../src/extensions/tdd/tdd.js';
import type { ObservationResult } from '../src/extensions/tdd/types.js';
import { fakeExtensionApi } from './extensionApi.js';
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

export const writeFiles = async (
  directory: string,
  files: Record<string, string>,
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
};

export const createCrate = async (
  cleanup: Parameters<typeof temporaryDirectory>[0],
  name: string,
  files: Record<string, string>,
): Promise<string> => {
  const directory = temporaryDirectory(cleanup, `tau-nextest-${name}-`);

  await writeFiles(directory, files);

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

    const watched = process.env.CARGO_TARGET_DIR;
    let previousState = '';

    process.stderr.write(
      `DIAG begin ${prefix} pid=${process.pid} now=${Date.now()} dir=${watched}\n`,
    );

    const timer = setInterval(() => {
      const state = `${existsSync(watched)}/${existsSync(join(watched, 'debug'))}/${existsSync(join(watched, 'debug', 'deps'))}`;

      if (state !== previousState) {
        process.stderr.write(
          `DIAG watch ${prefix} pid=${process.pid} now=${Date.now()} target/debug/deps=${state} env=${process.env.CARGO_TARGET_DIR}\n`,
        );

        previousState = state;
      }
    }, 10);

    registerCleanup(() => {
      clearInterval(timer);
      process.stderr.write(`DIAG end ${prefix} pid=${process.pid} now=${Date.now()}\n`);
    });
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

const runCommand = (command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 20_000 }).slice(0, 6000);
  } catch (error) {
    return `failed: ${String(error)}`;
  }
};

const diagnose = (label: string, extra: Record<string, unknown> = {}): string => {
  const targetDirectory = process.env.CARGO_TARGET_DIR ?? '';

  const cargoEnv = Object.entries(process.env).filter(([name]) =>
    /^(CARGO|RUST|NEXTEST)/.test(name),
  );

  return JSON.stringify(
    {
      label,
      now: Date.now(),
      pid: process.pid,
      ppid: process.ppid,
      cargoTargetDir: process.env.CARGO_TARGET_DIR,
      cargoEnv,
      targetExists: existsSync(targetDirectory),
      depsExists: existsSync(join(targetDirectory, 'debug', 'deps')),
      find: runCommand('find', [targetDirectory, '-maxdepth', '3']),
      lsTmp: runCommand('ls', ['-la', '/tmp']),
      listeners: {
        SIGTERM: process.listenerCount('SIGTERM'),
        SIGINT: process.listenerCount('SIGINT'),
        SIGHUP: process.listenerCount('SIGHUP'),
        exit: process.listenerCount('exit'),
      },
      ...extra,
    },
    null,
    1,
  );
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

  const metadataTarget = (JSON.parse(metadata.stdout) as { target_directory: string })
    .target_directory;

  const listed = await promisify(execFile)(
    'cargo',
    ['nextest', 'list', ...targetArguments(parsed), '--message-format', 'json'],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );

  const depsPath = join(process.env.CARGO_TARGET_DIR ?? '', 'debug', 'deps');

  if (!existsSync(depsPath)) {
    throw new Error(
      `DIAG prebuild: deps missing after list. ${diagnose('prebuild', {
        cwd,
        metadataTarget,
        stderr: listed.stderr.slice(0, 4000),
        stdout: listed.stdout.slice(0, 2000),
      })}`,
    );
  }
};

export const removeDepInfoFiles = async (packageName: string): Promise<void> => {
  const targetDirectory = process.env.CARGO_TARGET_DIR;

  if (targetDirectory === undefined) {
    throw new Error('CARGO_TARGET_DIR is not set; call useSharedCargoEnvironment first.');
  }

  const dependencies = join(targetDirectory, 'debug', 'deps');

  const entries = await readdir(dependencies).catch((error: unknown) => {
    throw new Error(`DIAG remove: ${String(error)} ${diagnose('removeDepInfoFiles')}`);
  });

  const depInfo = entries.filter(
    (entry) => entry.startsWith(`${packageName}-`) && entry.endsWith('.d'),
  );

  if (depInfo.length === 0) {
    throw new Error(`Found no dep-info files for ${packageName} in ${dependencies}.`);
  }

  await Promise.all(depInfo.map((entry) => rm(join(dependencies, entry))));
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
