import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readTauConfig } from '../../tauConfig/index.js';
import type { ConfigFile, ConfigLocation } from '../../tauConfig/index.js';
import { minimumThresholdTokens } from './decision.js';

export interface CompactionConfig {
  thresholdTokens: number;
}

const defaultCompactionConfig: CompactionConfig = { thresholdTokens: 200_000 };

// Other top-level keys belong to other consumers, possibly from a newer Tau sharing the user file.
const configFileSchema = Type.Object({
  compaction: Type.Optional(
    Type.Object(
      { thresholdTokens: Type.Optional(Type.Integer({ minimum: minimumThresholdTokens })) },
      { additionalProperties: false },
    ),
  ),
});

const thresholdLayer = ({ source, value }: ConfigFile): number | undefined => {
  if (!Value.Check(configFileSchema, value)) {
    throw new Error(
      `Invalid Tau config ${source}: expected {"compaction": {"thresholdTokens": <integer of at least ${minimumThresholdTokens}>}}.`,
    );
  }

  return value.compaction?.thresholdTokens;
};

// The repository file overrides the user file, which overrides the default.
export const loadCompactionConfig = (location: ConfigLocation): CompactionConfig => {
  const thresholds = readTauConfig(location).files.map(thresholdLayer);
  const configured = thresholds.findLast((threshold) => threshold !== undefined);

  return { thresholdTokens: configured ?? defaultCompactionConfig.thresholdTokens };
};
