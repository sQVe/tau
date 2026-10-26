import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Loader } from '@earendil-works/pi-tui';

interface LoaderFields {
  renderIndicatorVerbatim: boolean;
  spinnerColorFn: (text: string) => string;
  messageColorFn: (text: string) => string;
  message: string;
  ui: { requestRender: () => void } | null;
  setText: (text: string) => void;
}

const staticIndicator = '●';

const stopAnimation = function (this: Loader): void {
  this.stop();
};

const renderStaticIndicator = function (this: LoaderFields): string {
  return this.renderIndicatorVerbatim ? staticIndicator : this.spinnerColorFn(staticIndicator);
};

const updateMessageOnly = function (this: LoaderFields): void {
  this.setText(this.messageColorFn(this.message));

  if (this.ui) {
    this.ui.requestRender();
  }
};

// Every spinner frame requests a render, and Pi lays out the whole transcript again for it. The
// bash execution loader has its own Loader that setWorkingIndicator does not reach, so the patch
// goes on the prototype. The loader keeps its message, so waiting stays visible. When the editor
// border is too narrow for the message, Pi draws only the indicator there, so it stays as a dot.
export default function staticLoaderExtension(_pi: ExtensionAPI): void {
  Reflect.set(Loader.prototype, 'restartAnimation', stopAnimation);
  Reflect.set(Loader.prototype, 'getRenderedIndicator', renderStaticIndicator);
  Reflect.set(Loader.prototype, 'updateDisplay', updateMessageOnly);
}
