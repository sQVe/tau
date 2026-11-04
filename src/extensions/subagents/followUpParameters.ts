import { Type } from 'typebox';
import type { Static } from 'typebox';

import { uuidPattern } from './assignment.js';
import { launchParameters } from './launchParameters.js';

export const followUpParameters = Type.Object(
  {
    sourceAssignmentId: Type.String({ pattern: uuidPattern }),
    task: launchParameters.properties.task,
    acceptance: launchParameters.properties.acceptance,
    label: launchParameters.properties.label,
    timeoutSeconds: launchParameters.properties.timeoutSeconds,
  },
  { additionalProperties: false },
);

export type FollowUpParameters = Static<typeof followUpParameters>;
