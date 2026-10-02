import { parseModelEntry } from '../../models/models.js';
import { readUserOnlyKey, userConfigPath } from '../../tauConfig.js';
import type { ConfigLocation } from '../../tauConfig.js';

export const readBulkReadModel = (location: ConfigLocation): string | undefined => {
  const user = readUserOnlyKey(location, 'bulkRead');

  if (user === undefined) {
    return undefined;
  }

  return parseModelEntry(user.source, 'bulkRead', user.value);
};

export const requireBulkReadModel = (location: ConfigLocation): string => {
  const model = readBulkReadModel(location);

  if (model === undefined) {
    throw new Error(
      `bulk_read has no model. Set bulkRead.model to a provider/model-id in ${userConfigPath(location.agentDirectory)}.`,
    );
  }

  return model;
};
