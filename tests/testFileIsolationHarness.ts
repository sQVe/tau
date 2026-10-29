import * as fileSystem from 'node:fs';
import { readFileSync } from 'node:fs';
import * as fileSystemPromises from 'node:fs/promises';

import { afterAll, expect, vi } from 'vitest';

type ClassPrototype = Record<PropertyKey, unknown>;

// Test files share a worker and its loaded modules, so each file must leave none of its fakes behind.
// Vitest keeps module mocks per file, but a module that an earlier file loaded keeps its real
// imports, and a module loaded under a mock keeps the mock. A file that mocks modules therefore
// loads every module fresh and leaves none behind.
const mocksModules = (source: string) => /\bvi\.(?:mock|doMock)\(/v.test(source);

const prototypeChain = (prototype: ClassPrototype): ClassPrototype[] => {
  const chain: ClassPrototype[] = [];

  // Vitest stops at the same prototype, so spies never reach the ones that every object shares.
  for (
    let current: ClassPrototype | null = prototype;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as ClassPrototype | null
  ) {
    chain.push(current);
  }

  return chain;
};

const builtinPrototypes = (): Set<ClassPrototype> => {
  const exports: unknown[] = [...Object.values(fileSystem), ...Object.values(fileSystemPromises)];

  const classPrototypes = exports
    .filter((value): value is { prototype: unknown } => typeof value === 'function')
    .map((value) => value.prototype)
    .filter((prototype): prototype is ClassPrototype => typeof prototype === 'object');

  return new Set(classPrototypes.flatMap(prototypeChain));
};

const savePrototypes = () =>
  [...builtinPrototypes()].map(
    (prototype) => [prototype, Object.getOwnPropertyDescriptors(prototype)] as const,
  );

const restorePrototype = (prototype: ClassPrototype, descriptors: PropertyDescriptorMap) => {
  for (const key of Reflect.ownKeys(prototype)) {
    if (!Object.hasOwn(descriptors, key)) {
      Reflect.deleteProperty(prototype, key);
    }
  }

  Object.defineProperties(prototype, descriptors);
};

const testPath = expect.getState().testPath;

if (testPath !== undefined && mocksModules(readFileSync(testPath, 'utf8'))) {
  const savedPrototypes = savePrototypes();

  vi.resetModules();

  afterAll(() => {
    vi.resetModules();

    for (const [prototype, descriptors] of savedPrototypes) {
      restorePrototype(prototype, descriptors);
    }
  });
}

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
