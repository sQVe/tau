import { Loader } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import staticLoaderExtension from './staticLoader.js';

type PatchedMethod = 'restartAnimation' | 'getRenderedIndicator';

const loaderPrototype = Loader.prototype as unknown as Record<PatchedMethod, unknown>;
const animatedRestart = loaderPrototype.restartAnimation;
const spinnerIndicator = loaderPrototype.getRenderedIndicator;
const plain = (text: string) => text;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  loaderPrototype.restartAnimation = animatedRestart;
  loaderPrototype.getRenderedIndicator = spinnerIndicator;
  vi.useRealTimers();
});

it('shows only the message and requests no render after that', () => {
  staticLoaderExtension(fakeExtensionApi().pi);

  const requestRender = vi.fn<() => void>();
  const loader = new Loader({ requestRender } as never, plain, plain, 'Running sleep');
  const firstText = loader.render(80).join('\n');
  const rendersAfterStart = requestRender.mock.calls.length;

  vi.advanceTimersByTime(2000);

  expect(firstText.trim()).toBe('Running sleep');
  expect(loader.render(80).join('\n')).toBe(firstText);
  expect(requestRender).toHaveBeenCalledTimes(rendersAfterStart);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops the animation of an earlier loader when that loader restarts', () => {
  const requestRender = vi.fn<() => void>();
  const loader = new Loader({ requestRender } as never, plain, plain, 'Working');

  staticLoaderExtension(fakeExtensionApi().pi);
  loader.start();

  const restartedText = loader.render(80).join('\n');
  const rendersAfterRestart = requestRender.mock.calls.length;

  vi.advanceTimersByTime(2000);

  expect(restartedText.trim()).toBe('Working');
  expect(loader.render(80).join('\n')).toBe(restartedText);
  expect(requestRender).toHaveBeenCalledTimes(rendersAfterRestart);
  expect(vi.getTimerCount()).toBe(0);
});
