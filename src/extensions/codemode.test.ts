import { expect, it, vi } from 'vitest';

import { appendedSystemPrompt, fakeExtensionApi } from '../../tests/extensionApi.js';
import { codemodeGuidelines } from '../codemode/guidelines.js';
import codemodeExtension from './codemode.js';

it('adds no codemode guidance and no nested change refusal in a worker', ({ onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('TAU_WORKER_RECORD', undefined);
  const fake = fakeExtensionApi();

  codemodeExtension(fake.pi);

  expect(appendedSystemPrompt(fake.handlers, ['codemode'])).toBe('');
  expect(fake.handlers.has('tool_call')).toBe(false);
});

it('adds codemode guidance and a nested change refusal in a manager session', ({
  onTestFinished,
}) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_ROLE', undefined);
  vi.stubEnv('TAU_WORKER_RECORD', undefined);
  const fake = fakeExtensionApi();

  codemodeExtension(fake.pi);

  expect(appendedSystemPrompt(fake.handlers, ['codemode'])).toContain(codemodeGuidelines[0]);
  expect(fake.handlers.has('tool_call')).toBe(true);
});
