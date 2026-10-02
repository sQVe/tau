import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { snippetAutocomplete } from './autocomplete.js';
import { loadSnippets } from './snippet.js';
import type { Snippet } from './types.js';

const snippetsDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));

const handleSessionStart = async (context: ExtensionContext) => {
  if (context.mode !== 'tui') {
    return;
  }

  // Autocomplete reads this list on every keystroke, so it is loaded once per session.
  let snippets: Snippet[] = [];

  context.ui.addAutocompleteProvider(snippetAutocomplete(() => snippets));

  try {
    snippets = await loadSnippets(snippetsDirectory);
  } catch (error) {
    context.ui.notify(`Snippets could not be read: ${errorMessage(error)}`, 'warning');
  }
};

export default function snippetsExtension(pi: ExtensionAPI) {
  pi.on('session_start', (_event, context) => handleSessionStart(context));
}
