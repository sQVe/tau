import { afterEach, expect, it, vi } from 'vitest';

import { resolvePropertySeed } from './propertySeedHarness.ts';

const captureStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('defaults to seed 15 and prints it', () => {
  vi.stubEnv('TAU_PROPERTY_SEED', undefined);
  const write = captureStdout();

  expect(resolvePropertySeed()).toBe(15);
  expect(write.mock.calls).toEqual([['TAU_PROPERTY_SEED=15\n']]);
});

it('keeps an integer seed and prints it', () => {
  vi.stubEnv('TAU_PROPERTY_SEED', '7');
  const write = captureStdout();

  expect(resolvePropertySeed()).toBe(7);
  expect(write.mock.calls).toEqual([['TAU_PROPERTY_SEED=7\n']]);
});

it.each(['', '   '])('refuses the blank value %j without printing', (value) => {
  vi.stubEnv('TAU_PROPERTY_SEED', value);
  const write = captureStdout();

  expect(() => resolvePropertySeed()).toThrow(
    new TypeError('TAU_PROPERTY_SEED must be an integer or random, got an empty value'),
  );

  expect(write.mock.calls).toEqual([]);
});

it('draws a random seed and prints it', () => {
  vi.stubEnv('TAU_PROPERTY_SEED', 'random');
  const write = captureStdout();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const seed = resolvePropertySeed();

  expect(seed).toBe(1073741824);
  expect(Number.isInteger(seed)).toBe(true);
  expect(seed).toBeGreaterThanOrEqual(0);
  expect(seed).toBeLessThan(2 ** 31);
  expect(write.mock.calls).toEqual([['TAU_PROPERTY_SEED=1073741824\n']]);
});

it('refuses a non-integer value and names it', () => {
  vi.stubEnv('TAU_PROPERTY_SEED', '1.5');
  const write = captureStdout();

  expect(() => resolvePropertySeed()).toThrow(
    'TAU_PROPERTY_SEED must be an integer or random, got 1.5',
  );

  expect(write.mock.calls).toEqual([]);
});
