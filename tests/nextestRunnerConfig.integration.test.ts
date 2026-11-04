import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import tddExtension from '../src/extensions/tdd/tdd.js';
import { fakeExtensionApi } from './extensionApi.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const staleHint = 'Hint: Test results are stale; rerun run_tests on the current inputs.';

let previousTargetDirectory: string | undefined;
let previousAgentDirectory: string | undefined;

beforeAll(() => {
  previousTargetDirectory = process.env.CARGO_TARGET_DIR;
  previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;

  process.env.CARGO_TARGET_DIR = temporaryDirectory(afterAll, 'tau-nextest-config-target-');
  process.env.PI_CODING_AGENT_DIR = temporaryDirectory(afterAll, 'tau-nextest-config-agent-');
});

afterAll(() => {
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

const createNextestCrate = async (
  cleanup: Parameters<typeof temporaryDirectory>[0],
): Promise<string> => {
  const cwd = temporaryDirectory(cleanup, 'tau-nextest-config-');

  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, '.pi'), { recursive: true });

  await writeFile(
    join(cwd, 'Cargo.toml'),
    '[package]\nname = "probe_config"\nversion = "0.1.0"\nedition = "2021"\n',
  );

  await writeFile(
    join(cwd, 'src/lib.rs'),
    [
      'pub fn adds(a: i32, b: i32) -> i32 { a + b }',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    #[test]',
      '    fn adds() { assert_eq!(super::adds(1, 2), 3); }',
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(join(cwd, '.pi', 'tau.json'), JSON.stringify({ tdd: { runner: 'nextest' } }));

  return cwd;
};

const setup = () => {
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

  const run = (cwd: string) =>
    tool.execute(
      'run',
      {
        behavior: 'adds',
        testFullName: 'tests::adds',
        files: ['src/lib.rs'],
        scope: 'focused',
      },
      undefined,
      undefined,
      contextFor(cwd),
    );

  const edit = async (cwd: string) => {
    await appendFile(join(cwd, 'src/lib.rs'), 'pub fn doubles(a: i32) -> i32 { a * 2 }\n');

    return fake.handler('tool_result')(
      {
        toolName: 'write',
        input: { path: 'src/lib.rs' },
        isError: false,
        content: [{ type: 'text', text: 'Original result' }],
      },
      contextFor(cwd),
    );
  };

  return { run, edit };
};

it('accepts src/lib.rs for the nextest runner and fires the production checkpoint after a real edit', async ({
  onTestFinished,
}) => {
  const cwd = await createNextestCrate(onTestFinished);
  const application = setup();

  // The first run creates Cargo.lock, which the nextest configuration globs fingerprint. The
  // second run then sees stable inputs, so only the edit to src/lib.rs makes the results stale.
  await application.run(cwd);

  const result = (await application.run(cwd)) as { details: { kind: string } };

  expect(result.details).toMatchObject({ kind: 'pass' });

  const patch = await application.edit(cwd);

  expect(patch).toEqual({
    content: [
      { type: 'text', text: 'Original result' },
      { type: 'text', text: staleHint },
    ],
  });
});
