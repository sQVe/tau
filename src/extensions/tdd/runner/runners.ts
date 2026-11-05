import type { TestRunner } from './types.js';
import { vitestRunner } from './vitest.js';

export const runners = { vitest: vitestRunner } as const;

export const lookupRunner = (name: keyof typeof runners): TestRunner => runners[name];
