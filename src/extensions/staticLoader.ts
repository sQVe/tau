import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Loader } from '@earendil-works/pi-tui';

const stopAnimation = function (this: Loader): void {
  this.stop();
};

const hideSpinner = (): string => '';

// Every spinner frame requests a render, and Pi lays out the whole transcript again for it. The
// bash execution loader has its own Loader that setWorkingIndicator does not reach, so the patch
// goes on the prototype. The loader keeps its message, so waiting stays visible.
export default function staticLoaderExtension(_pi: ExtensionAPI): void {
  Reflect.set(Loader.prototype, 'restartAnimation', stopAnimation);
  Reflect.set(Loader.prototype, 'getRenderedIndicator', hideSpinner);
}
