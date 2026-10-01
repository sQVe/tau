import { expect, it, vi } from 'vitest';

import { createTestObservation } from './observation.js';
import { runTests } from './runner/vitest.js';

// Exercise Node's Windows path rules on every host, without claiming Windows runner coverage.
// eslint-disable-next-line tau/no-module-mocking -- Applies Windows path rules on a POSIX host. createTestObservation takes no path module, so path.win32 cannot be passed in.
vi.mock(import('node:path'), async (importOriginal) => {
  const path = await importOriginal();

  return { ...path, ...path.win32 };
});

// eslint-disable-next-line tau/no-module-mocking -- Returns chosen runner results instead of starting a nested Vitest process. createTestObservation takes no runner, so runTests cannot be passed in.
vi.mock(import('./runner/vitest.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  runTests: vi.fn<typeof runTests>(),
}));

it('accepts native Windows separators in literal relative test paths', async () => {
  vi.mocked(runTests).mockResolvedValue({ kind: 'pass', tests: [] });
  const observation = createTestObservation('C:\\work');

  await observation.run(
    { behavior: 'value', testFullName: 'value works', files: ['tests\\value.test.ts'] },
    'focused',
  );

  expect(runTests).toHaveBeenCalledWith(
    expect.objectContaining({ files: ['tests/value.test.ts'], scope: 'changed' }),
  );
});

it('retains literal path and worktree restrictions with Windows path rules', async () => {
  vi.mocked(runTests).mockReset().mockResolvedValue({ kind: 'pass', tests: [] });
  const observation = createTestObservation('C:\\work');

  const invalidPaths = [
    '..\\value.test.ts',
    'tests\\..\\..\\value.test.ts',
    'C:\\work\\value.test.ts',
    'D:tests\\value.test.ts',
    '\\\\server\\share\\value.test.ts',
    '\\value.test.ts',
    'tests\\*.test.ts',
    'tests\\?.test.ts',
    'tests\\[value].test.ts',
    'tests\\{value}.test.ts',
    'tests\\\0value.test.ts',
    'tests*\\..\\value.test.ts',
    '@tests\\value.test.ts',
    'src\\value.ts',
  ];

  for (const file of invalidPaths) {
    await expect(
      observation.run({ behavior: 'value', testFullName: 'value works', files: [file] }, 'focused'),
    ).rejects.toThrow('Expected a test file');
  }

  expect(runTests).not.toHaveBeenCalled();
});
