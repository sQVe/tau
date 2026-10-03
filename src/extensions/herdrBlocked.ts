import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Herdr's own Pi integration listens for herdr:blocked and shows the pane as blocked. Pi sends
// ui_prompt_start and ui_prompt_end only for the outermost prompt, so the events pair up.
export default function herdrBlockedExtension(pi: ExtensionAPI): void {
  pi.on('ui_prompt_start', (event) => {
    pi.events.emit('herdr:blocked', { active: true, label: event.title ?? event.kind });
  });

  pi.on('ui_prompt_end', () => {
    pi.events.emit('herdr:blocked', { active: false });
  });
}
