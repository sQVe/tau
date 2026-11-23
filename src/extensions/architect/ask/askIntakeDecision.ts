import type { GateRecordRead } from '../record.js';
import { gateRoutingQuestion } from './gateQuestion.js';

export interface AskIntakeFacts {
  askId: string | undefined;
  question: string | undefined;
  gate: string | undefined;
  gateRead: GateRecordRead | undefined;
}

export type AskIntakeDecision =
  | { kind: 'retry'; askId: string }
  | { kind: 'ask'; question: string; gateRecord: string | null }
  | { kind: 'refusal'; message: string };

const refusal = (message: string): AskIntakeDecision => ({ kind: 'refusal', message });

const unsetWhenBlank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

const gateIntake = (gate: string, read: GateRecordRead | undefined): AskIntakeDecision => {
  if (read === undefined) {
    return refusal(`gate record ${gate} does not exist.`);
  }

  if (read.kind === 'outside') {
    return refusal(`gate ${gate} is not a gate record in ${read.directory}.`);
  }

  if (read.kind === 'missing') {
    return refusal(`gate record ${gate} does not exist.`);
  }

  if (read.kind === 'unreadable') {
    return refusal(read.message);
  }

  if (read.record.decision !== 'uncertain') {
    return refusal(
      `gate record ${gate} is ${read.record.decision}, not uncertain. Follow it instead of asking.`,
    );
  }

  return { kind: 'ask', question: gateRoutingQuestion(read.record), gateRecord: read.path };
};

export const decideAskIntake = (facts: AskIntakeFacts): AskIntakeDecision => {
  const question = unsetWhenBlank(facts.question);
  const gate = unsetWhenBlank(facts.gate);

  if (facts.askId !== undefined) {
    if (question !== undefined) {
      return refusal('action ask with askId does not take question.');
    }

    if (gate !== undefined) {
      return refusal('action ask with askId does not take gate.');
    }

    return { kind: 'retry', askId: facts.askId };
  }

  if (question !== undefined && gate !== undefined) {
    return refusal('action ask takes question or gate, not both.');
  }

  if (question !== undefined) {
    return { kind: 'ask', question, gateRecord: null };
  }

  if (gate === undefined) {
    return refusal('question or gate is required.');
  }

  return gateIntake(gate, facts.gateRead);
};
