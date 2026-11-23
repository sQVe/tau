import type { ConfigWarnings } from '../../src/config/config.ts';

export const stderrConfigWarnings: ConfigWarnings = {
  notify: (message) => {
    process.stderr.write(`${message}\n`);
  },
};
