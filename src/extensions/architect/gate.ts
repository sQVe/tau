import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

import { classifyChoice } from '../../classifier/classifier.js';
import type { ChoiceOutcome, ChoiceQuestion } from '../../classifier/classifier.js';
import type { ConfigLocation } from '../../config/config.js';
import { readAllowedModels } from '../../config/models.js';
import { gateConfidenceCutoff, gateDecision } from './gateDecision.js';
import { writeGateRecord } from './record.js';
import type { GateRecord } from './record.js';

export interface GateRequest {
  root: string;
  request: string;
  restatement: string;
  location: ConfigLocation;
  context: Pick<ExtensionToolContext, 'modelRegistry'>;
  signal: AbortSignal | undefined;
}

export interface GateResult {
  decision: 'specified' | 'open';
  label: string | null;
  confidence: number | null;
  recordPath: string;
}

export const gateClassifier = 'typesafe/jev-latest';

const gateQuestion: ChoiceQuestion = {
  instructions: 'Is this request fully specified for a worker brief?',
  criteria: {
    specified: 'It names the change, the files or behavior, and how to check it.',
    open: 'It needs a design choice, research, or a plan.',
  },
};

const classifierAvailable = (location: ConfigLocation): boolean => {
  const allowed = readAllowedModels(location);

  return allowed === undefined || allowed.models.includes(gateClassifier);
};

const classify = (request: GateRequest): Promise<ChoiceOutcome> =>
  classifyChoice(
    request.context,
    gateClassifier,
    { request: request.request, restatement: request.restatement },
    gateQuestion,
    request.signal,
  );

// Records every call, including an unavailable classifier, so the gate's shadow decisions can be
// reviewed against what the lead did.
export const runGate = async (request: GateRequest): Promise<GateResult> => {
  const outcome: ChoiceOutcome = classifierAvailable(request.location)
    ? await classify(request)
    : { kind: 'unavailable' };

  const decision = gateDecision({ outcome, cutoff: gateConfidenceCutoff });

  const record: GateRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    request: request.request,
    restatement: request.restatement,
    outcome,
    ...decision,
  };

  const recordPath = await writeGateRecord(request.root, record);

  return { ...decision, recordPath };
};
