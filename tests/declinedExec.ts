import type { Exec } from '../src/command.js';

// Fails every command, so an SSH Host alias keeps its host.
export const declinedExec: Exec = () =>
  Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'declined' });
