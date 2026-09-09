import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { requireRegisteredTools } from '../../bundledTools/index.js';

// fetch_content pages oversized results through get_search_content, so the guard
// has to pass every tool the package registers, not just the two Tau promises.
// These are the package's default names, so the package's `toolNames` renaming
// option does not work under Tau: a renamed tool registers but the guard blocks it.
export const WEB_ACCESS_TOOLS = [
  'web_search',
  'source_check',
  'fetch_content',
  'get_search_content',
];

const REQUIRED_WEB_ACCESS_TOOLS = ['web_search', 'fetch_content'];

export default function webAccessExtension(pi: ExtensionAPI) {
  requireRegisteredTools(pi, 'pi-web-access', REQUIRED_WEB_ACCESS_TOOLS);
}
