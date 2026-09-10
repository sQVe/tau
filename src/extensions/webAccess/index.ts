import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { requireRegisteredTools } from '../../bundledTools/index.js';

// fetch_content uses get_search_content to page through oversized results. The guard
// must allow every tool the package registers, including tools Tau does not require.
// The package's `toolNames` option cannot rename tools under Tau: renamed tools
// register, but the guard blocks them because it only knows the default names.
export const WEB_ACCESS_TOOLS = [
  'web_search',
  'source_check',
  'fetch_content',
  'get_search_content',
];

const REQUIRED_WEB_ACCESS_TOOLS = ['web_search', 'fetch_content'];

export default function webAccessExtension(extensionApi: ExtensionAPI) {
  requireRegisteredTools(extensionApi, 'pi-web-access', REQUIRED_WEB_ACCESS_TOOLS);
}
