import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readTauConfig } from '../../tauConfig/index.js';
import type { ConfigFile, ConfigLocation } from '../../tauConfig/index.js';

export interface CompactionConfig {
  reminderTokens: number;
}

const defaultCompactionConfig: CompactionConfig = { reminderTokens: 200_000 };

// Other top-level keys belong to other consumers, possibly from a newer Tau sharing the user file.
const configFileSchema = Type.Object({
  compaction: Type.Optional(
    Type.Object(
      { reminderTokens: Type.Optional(Type.Integer({ minimum: 1 })) },
      { additionalProperties: false },
    ),
  ),
});

const reminderLayer = ({ source, value }: ConfigFile): number | undefined => {
  if (!Value.Check(configFileSchema, value)) {
    throw new Error(
      `Invalid Tau config ${source}: expected {"compaction": {"reminderTokens": <positive integer>}}.`,
    );
  }

  return value.compaction?.reminderTokens;
};

// The repository file overrides the user file, which overrides the default.
export const loadCompactionConfig = (location: ConfigLocation): CompactionConfig => {
  const thresholds = readTauConfig(location).files.map(reminderLayer);
  const configured = thresholds.findLast((threshold) => threshold !== undefined);

  return { reminderTokens: configured ?? defaultCompactionConfig.reminderTokens };
};
