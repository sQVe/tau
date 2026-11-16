import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readViewerRequest } from './viewerProtocol.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'viewerProtocol', 'request');

const directoryWith = async (fixture: string) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-viewer-request-');

  await cp(join(fixtures, fixture), join(directory, 'request.json'));

  return directory;
};

const recordFiles = async (directory: string) => {
  const names = (await readdir(directory)).toSorted();

  return Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
  );
};

const textOf = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const requestPath = (directory: string) => join(directory, 'request.json');

const refusal = async (directory: string) => {
  const before = await recordFiles(directory);
  const failure = await readViewerRequest(directory).catch((error: unknown) => error);

  return { before, failure, after: await recordFiles(directory) };
};

it('reads the current request as saved', async () => {
  const directory = await directoryWith('current.json');
  const text = await readFile(requestPath(directory), 'utf8');

  const request = await readViewerRequest(directory);

  expect(request).toEqual(JSON.parse(text));
});

it('reads a request without a manager terminal or reviewed item', async () => {
  const directory = await directoryWith('manual.json');

  const request = await readViewerRequest(directory);

  expect(request).toMatchObject({ managerTerminal: null });
  expect(request).not.toHaveProperty('reviewedItem');
});

it('refuses a version 1 request', async () => {
  const directory = await directoryWith('version-1.json');

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/saved by an older Tau/);
  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});

it('refuses a newer request', async () => {
  const directory = await directoryWith('newer.json');

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/newer format/);
  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});

it('refuses a malformed request', async () => {
  const directory = await directoryWith('malformed.json');

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/Malformed viewer request/);
  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});

it('refuses a staged path outside the staging directory', async () => {
  const directory = await directoryWith('staged-path-outside.json');

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toMatch(
    /staged path \.\.\/outside\.md is outside the staging directory/,
  );

  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});

it('refuses a relative staging directory', async () => {
  const directory = await directoryWith('manual.json');

  const fixture = JSON.parse(await readFile(requestPath(directory), 'utf8')) as Record<
    string,
    unknown
  >;

  await writeFile(requestPath(directory), textOf({ ...fixture, stagingDirectory: 'staging' }));

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/stagingDirectory must be an absolute path/);
  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});

it('gives undefined without request.json', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-viewer-request-');

  await expect(readViewerRequest(directory)).resolves.toBeUndefined();
});

it('refuses a dot-dot segment that stays inside', async () => {
  const directory = await directoryWith('manual.json');

  const fixture = JSON.parse(await readFile(requestPath(directory), 'utf8')) as {
    files: { path: string; stagedPath: string }[];
  };

  const files = fixture.files.map((file, index) =>
    index === 1 ? { ...file, stagedPath: '01-notes/../01-notes/2-body.md' } : file,
  );

  await writeFile(requestPath(directory), textOf({ ...fixture, files }));

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/is outside the staging directory/);
  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});

it('refuses an absolute staged path', async () => {
  const directory = await directoryWith('manual.json');

  const fixture = JSON.parse(await readFile(requestPath(directory), 'utf8')) as {
    files: { path: string; stagedPath: string }[];
  };

  const files = fixture.files.map((file, index) =>
    index === 1 ? { ...file, stagedPath: '/tmp/outside.md' } : file,
  );

  await writeFile(requestPath(directory), textOf({ ...fixture, files }));

  const { before, failure, after } = await refusal(directory);

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toMatch(
    /staged path \/tmp\/outside\.md is outside the staging directory/,
  );

  expect((failure as Error).message).toContain(requestPath(directory));
  expect(after).toEqual(before);
});
