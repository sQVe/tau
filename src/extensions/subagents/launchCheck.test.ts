import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import { launchRefusalMessage } from '../../../tests/refusalMessage.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { appAnswers } from './appProbe.js';
import type * as appProbe from './appProbe.js';
import { checkLaunchEnvironment } from './launchCheck.js';
import { applyQaSettings } from './qaLaunch.js';
import type * as qaLaunch from './qaLaunch.js';
import { textLimit } from './types.js';

vi.mock(import('./qaLaunch.js'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    applyQaSettings: vi.fn<typeof actual.applyQaSettings>(async (parameters) => parameters),
  };
});

vi.mock(import('./appProbe.js'), () => ({
  appAnswers: vi.fn<typeof appProbe.appAnswers>(async () => true),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(applyQaSettings).mockImplementation(async (parameters) => parameters);
  vi.mocked(appAnswers).mockResolvedValue(true);
});

const address = 'http://localhost:3000';

const launch = (root: string, task = 'Test the form.', url = ` \n${address}\n `, profile = 'qa') =>
  checkLaunchEnvironment(
    { profile, task, cwd: '.', url },
    undefined,
    { ...noUiContext(root), isProjectTrusted: () => true },
    declinedExec,
  );

it('trims the app URL before the probe', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');
  const parameters = await launch(root);

  expect(vi.mocked(appAnswers)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(appAnswers)).toHaveBeenCalledWith(address, undefined);
  expect(parameters.url).toBe(address);
});

it('checks the brief limit against the trimmed app URL', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');
  const line = `\n\nApp URL: ${address}`;
  const task = 'x'.repeat(textLimit - Array.from(line).length);

  const parameters = await launch(root, task);

  expect(vi.mocked(appAnswers)).toHaveBeenCalledTimes(1);
  expect(parameters.task).toBe(task);
  expect(parameters.url).toBe(address);
});

it('resolves a blank url that applyQaSettings fills', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');

  vi.mocked(applyQaSettings).mockImplementationOnce(async (parameters) => ({
    ...parameters,
    url: address,
  }));

  const parameters = await launch(root, 'Test the form.', '   ');

  expect(vi.mocked(appAnswers)).toHaveBeenCalledTimes(1);
  expect(parameters.url).toBe(address);
});

it('refuses a whitespace-only qa url and passes no url to applyQaSettings', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');

  expect(await launchRefusalMessage(() => launch(root, 'Test the form.', '   '))).toBe(
    'Launch refused: the url is blank. Pass an http or https URL.',
  );

  expect(vi.mocked(applyQaSettings)).toHaveBeenCalledTimes(1);

  const lastCall = vi.mocked(applyQaSettings).mock.calls.at(-1);

  expect(lastCall?.[0]).not.toHaveProperty('url');
  expect(vi.mocked(appAnswers)).not.toHaveBeenCalled();
});

it('does not claim a urlCommand ran when the worktree is missing', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');
  const actual = await vi.importActual<typeof qaLaunch>('./qaLaunch.js');

  vi.mocked(applyQaSettings).mockImplementationOnce(actual.applyQaSettings);

  const message = await launchRefusalMessage(() =>
    checkLaunchEnvironment(
      { profile: 'qa', task: 'Test the form.', cwd: 'missing', url: '   ' },
      undefined,
      { ...noUiContext(root), isProjectTrusted: () => true },
      declinedExec,
    ),
  );

  expect(message).toBe('Launch refused: the url is blank. Pass an http or https URL.');
});

it('does not name urlCommand for a blank browser url', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');

  expect(await launchRefusalMessage(() => launch(root, 'Test the form.', '   ', 'browser'))).toBe(
    'Launch refused: the url is blank. Pass an http or https URL.',
  );

  expect(vi.mocked(appAnswers)).not.toHaveBeenCalled();
});

it('refuses a blank reviewer url with the profile message', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');

  expect(await launchRefusalMessage(() => launch(root, 'Test the form.', '   ', 'reviewer'))).toBe(
    'url applies only to the qa and browser profiles.',
  );

  expect(vi.mocked(appAnswers)).not.toHaveBeenCalled();
});

it('names the trimmed app URL in the refusal when no server answers', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-check-');
  vi.mocked(appAnswers).mockResolvedValueOnce(false);

  expect(await launchRefusalMessage(() => launch(root))).toBe(
    `Launch refused: no server at ${address}. Start the app, then launch again.`,
  );

  expect(vi.mocked(appAnswers)).toHaveBeenCalledTimes(1);
});
