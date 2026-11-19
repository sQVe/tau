import { join } from 'node:path';

import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// Writes a saved session file through Pi's SDK and returns its path. Pi saves a file only once it
// holds an assistant message, and adds its own model entries to a file that has none.
export const seedSavedSession = (directory: string): string => {
  const sessionDirectory = join(directory, 'sessions');
  const manager = SessionManager.create(directory, sessionDirectory);

  manager.appendModelChange('faux', 'faux-1');
  manager.appendThinkingLevelChange('off');
  manager.appendMessage({ role: 'user', content: 'Hello', timestamp: 0 });
  manager.appendMessage(fauxAssistantMessage('Hi.'));

  const sessionFile = manager.getSessionFile();

  if (sessionFile === undefined) {
    throw new Error('The seeded session saved no file.');
  }

  return sessionFile;
};
