import { expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import toolResultRedaction from './toolResultRedaction.js';

interface WithheldResult {
  content: unknown;
  details: unknown;
  structuredContent: unknown;
  isError: unknown;
}

const isWithheldResult = (value: unknown): value is WithheldResult => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return ['content', 'details', 'structuredContent', 'isError'].every((key) => key in value);
};

const withheldResultFor = (structuredContent: unknown): WithheldResult => {
  vi.stubEnv('TAU_FAKE_API_KEY', 'fake-secret-value-1234567890');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const { pi, handler } = fakeExtensionApi();

  toolResultRedaction(pi);

  const details = {
    get broken(): string {
      throw new Error('unreadable');
    },
  };

  const result = handler('tool_result')(
    { content: [{ type: 'text', text: 'output' }], details, structuredContent },
    {} as never,
  );

  if (!isWithheldResult(result)) {
    throw new Error('The redaction handler returned no withheld result.');
  }

  return result;
};

it('withholds the result when redaction throws', () => {
  const { content, details, isError } = withheldResultFor(undefined);

  expect({ content, details, isError }).toStrictEqual({
    content: [
      { type: 'text', text: 'Tau withheld this tool result because secret redaction failed.' },
    ],
    details: {},
    isError: true,
  });
});

it('clears structured content when redaction throws on a result that has it', () => {
  expect(withheldResultFor({ value: 'structured output' }).structuredContent).toStrictEqual({});
});
