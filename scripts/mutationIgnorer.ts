import type { Ignorer } from '@stryker-mutator/api/ignore';
import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

import { ignoreReason, ignorerName } from './mutationIgnorePolicy.ts';
import type { BabelPath } from './mutationIgnorePolicy.ts';

export const mutationIgnorer: Ignorer = {
  shouldIgnore(path) {
    // SAFETY: Stryker passes a Babel NodePath; BabelPath lists the fields read here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the API types the path as empty.
    return ignoreReason(path as unknown as BabelPath);
  },
};

export const strykerPlugins = [declareValuePlugin(PluginKind.Ignore, ignorerName, mutationIgnorer)];
