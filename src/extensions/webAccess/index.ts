import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { requireRegisteredTools } from '../../bundledTools/index.js';
import { delegateReference } from '../bulkRead/index.js';

// fetch_content uses get_search_content to page through oversized results. The guard
// must allow every tool the package registers, including tools Tau does not require.
// The package's `toolNames` option cannot rename tools under Tau: renamed tools
// register, but the guard blocks them because it only knows the default names.
export const webAccessTools = ['web_search', 'source_check', 'fetch_content', 'get_search_content'];

const requiredWebAccessTools = ['web_search', 'fetch_content'];

export default function webAccessExtension(extensionApi: ExtensionAPI) {
  requireRegisteredTools(extensionApi, 'pi-web-access', requiredWebAccessTools);

  // pi-web-access treats a blank answerModel as absent and falls back to the session model.
  extensionApi.on('tool_call', (event) => {
    if (event.toolName !== 'fetch_content' || event.input.mode !== 'answer') {
      return;
    }

    if (typeof event.input.answerModel === 'string' && event.input.answerModel.trim() !== '') {
      return;
    }

    event.input.answerModel = delegateReference();
  });
}
