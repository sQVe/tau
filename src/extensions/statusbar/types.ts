import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface FooterInput {
  directory: string;
  branch: string | null;
  dirty: boolean;
  tddGateOff: boolean;
  cost: number;
  contextPercent: number | null;
  contextWindow: number;
  modelId: string;
  thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']> | undefined;
}
