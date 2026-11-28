import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const loadTool = async (definition: string) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-pi-host-');
  const path = join(directory, 'tool.js');

  await writeFile(path, `export default (pi) => {\n  pi.registerTool(${definition});\n};\n`);

  return discoverAndLoadExtensions([path], directory, directory);
};

it('refuses a tool definition without an object parameter schema', async () => {
  const result = await loadTool(
    "{ name: 'no-parameters', label: 'x', description: 'x', execute: async () => ({}) }",
  );

  expect(result.errors.map(({ error }) => error)).toEqual([
    expect.stringContaining('must define an object parameter schema'),
  ]);

  expect(result.extensions).toEqual([]);
});

it('stores a tool definition that has an object parameter schema', async () => {
  const result = await loadTool(
    "{ name: 'with-parameters', label: 'x', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({}) }",
  );

  expect(result.errors).toEqual([]);

  const [extension] = result.extensions;

  expect(extension?.tools.get('with-parameters')?.definition.parameters).toEqual({
    type: 'object',
    properties: {},
  });
});
