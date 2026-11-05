import { expect, it, vi } from 'vitest';

import {
  cargoPackage,
  createCrate,
  createNextestTool,
  libraryWith,
  nextestConfig,
  useSharedCargoEnvironment,
} from './nextestHarness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

useSharedCargoEnvironment('nextest-config');

const staleHint = 'Hint: Test results are stale; rerun run_tests on the current inputs.';

const setup = () => {
  const application = createNextestTool();

  const run = (cwd: string) =>
    application.run(cwd, {
      behavior: 'adds',
      testFullName: 'tests::adds',
      files: ['src/lib.rs'],
    });

  return { run, edit: application.edit };
};

it('accepts src/lib.rs for the nextest runner and fires the production checkpoint after a real edit', async ({
  onTestFinished,
}) => {
  const cwd = await createCrate(onTestFinished, 'config', {
    'Cargo.toml': cargoPackage('probe_config'),
    'src/lib.rs': [
      'pub fn adds(a: i32, b: i32) -> i32 { a + b }',
      '',
      libraryWith('    #[test]\n    fn adds() { assert_eq!(super::adds(1, 2), 3); }'),
    ].join('\n'),
    '.pi/tau.json': nextestConfig,
  });

  const application = setup();

  // The first run creates Cargo.lock, which the nextest configuration globs fingerprint. The
  // second run then sees stable inputs, so only the edit to src/lib.rs makes the results stale.
  await application.run(cwd);

  const result = await application.run(cwd);

  expect(result.details).toMatchObject({ kind: 'pass' });

  const patch = await application.edit(
    cwd,
    'src/lib.rs',
    'pub fn doubles(a: i32) -> i32 { a * 2 }\n',
  );

  expect(patch).toEqual({
    content: [
      { type: 'text', text: 'Original result' },
      { type: 'text', text: staleHint },
    ],
  });
});
