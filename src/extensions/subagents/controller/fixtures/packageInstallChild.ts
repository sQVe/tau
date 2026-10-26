import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

import { fixtureLoadout } from '../../fixtures/loadout.js';
import { installWorkerPackages } from '../packageInstall.js';
import { observeInstallLockRead } from './installLockRead.js';
import { fakePackageRoot, writeFakePackage } from './packageCache.js';

const [agentDirectory, record, name, observation, release] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];

filesystem.readFile = observeInstallLockRead(filesystem.readFile, agentDirectory, () => {
  writeFileSync(observation, 'waiting');
});

syncBuiltinESMExports();

await installWorkerPackages(
  { ...fixtureLoadout(agentDirectory), packages: [`npm:${name}`] },
  () => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async (sources) => {
      writeFileSync(observation, 'entered');
      appendFileSync(record, `start ${name}\n`);

      while (!existsSync(release)) {
        await sleep(10);
      }

      appendFileSync(record, `end ${name}\n`);
      const source = sources[0]!;

      writeFakePackage(agentDirectory, source);

      return {
        extensions: [
          {
            path: source,
            enabled: true,
            metadata: {
              source,
              scope: 'temporary',
              origin: 'package',
              packageRoot: fakePackageRoot(agentDirectory, source),
            },
          },
        ],
        skills: [],
        prompts: [],
        themes: [],
      };
    },
  }),
  new AbortController().signal,
);
