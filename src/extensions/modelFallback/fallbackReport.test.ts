import { expect, it, vi } from 'vitest';

import type { ConfigWarnings } from '../../config/config.js';
import type { FallbackModelsRead } from './fallbackConfig.js';
import { reportFallbackModels, writeFallbackModelsReport } from './fallbackReport.js';

const createUi = () => {
  const notify = vi.fn<ConfigWarnings['notify']>();

  return { ui: { notify }, notify };
};

const model = {
  name: 'deepseek-flash',
  primary: 'morph/morph-dsv41flash-1017',
  fallback: 'openrouter/deepseek/deepseek-v4.1-flash-1017',
  fallbackAtRetry: 5,
};

const cleanRead: FallbackModelsRead = { models: [model], problems: [], warnings: [] };

it('reports problems as errors and warnings as warnings', () => {
  const { ui, notify } = createUi();

  reportFallbackModels(ui, {
    models: [],
    problems: ['Invalid Tau config /agent/tau.json: fallbackModels must be an object.'],
    warnings: ['Invalid Tau config /agent/tau.json: fallbackModels.a has unknown key extra.'],
  });

  expect(notify.mock.calls).toEqual([
    ['Invalid Tau config /agent/tau.json: fallbackModels must be an object.', 'error'],
    ['Invalid Tau config /agent/tau.json: fallbackModels.a has unknown key extra.', 'warning'],
  ]);
});

it('reports nothing for a clean read', () => {
  const { ui, notify } = createUi();

  reportFallbackModels(ui, cleanRead);

  expect(notify).not.toHaveBeenCalled();
});

it('writes problems and warnings as Pi diagnostics', () => {
  const written: string[] = [];

  writeFallbackModelsReport((text) => written.push(text), {
    models: [],
    problems: ['Invalid Tau config /agent/tau.json: fallbackModels must be an object.'],
    warnings: ['Invalid Tau config /agent/tau.json: fallbackModels.a has unknown key extra.'],
  });

  expect(written).toEqual([
    'Error: Invalid Tau config /agent/tau.json: fallbackModels must be an object.\n',
    'Warning: Invalid Tau config /agent/tau.json: fallbackModels.a has unknown key extra.\n',
  ]);
});

it('writes nothing for a clean read at startup', () => {
  const written: string[] = [];

  writeFallbackModelsReport((text) => written.push(text), cleanRead);

  expect(written).toEqual([]);
});
