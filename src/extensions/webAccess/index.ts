import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const WEB_ACCESS_TOOLS = ['web_search', 'fetch_content'];

export default function webAccessExtension(pi: ExtensionAPI) {
  pi.on('session_start', () => {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const missing = WEB_ACCESS_TOOLS.filter((name) => !registered.has(name));

    if (missing.length > 0) {
      throw new Error(
        `Tools ${missing.map((name) => `"${name}"`).join(', ')} are not registered. The bundled package pi-web-access failed to load; reinstall Tau.`,
      );
    }
  });
}
