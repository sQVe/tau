import type { ExtensionAPI, ModelRouteRequest } from '@earendil-works/pi-coding-agent';

import type { FallbackModel } from '../../config/fallbackModels.js';
import { resolveAllowedModel } from '../../config/models.js';
import { decideFallbackRoute } from './fallbackRoute.js';
import type { FallbackRouteState } from './fallbackRoute.js';

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const referenceOf = (model: { provider: string; id: string }): string =>
  `${model.provider}/${model.id}`;

const previousOnFallback = (request: ModelRouteRequest, model: FallbackModel): boolean =>
  request.previous !== undefined && referenceOf(request.previous.model) === model.fallback;

export const registerFallbackModels = (
  pi: Pick<ExtensionAPI, 'registerVirtualModel'>,
  models: readonly FallbackModel[],
): void => {
  for (const model of models) {
    pi.registerVirtualModel<FallbackRouteState>({
      provider: 'tau',
      id: model.name,
      name: `${model.primary} with fallback ${model.fallback}`,
      thinkingLevels,
      route(request, context) {
        const decision = decideFallbackRoute({
          reason: request.reason,
          state: request.state,
          previousOnFallback: previousOnFallback(request, model),
          fallbackAtRetry: model.fallbackAtRetry,
        });

        const reference = decision.target === 'fallback' ? model.fallback : model.primary;
        const routed = resolveAllowedModel(context, reference);

        return { model: routed, thinkingLevel: request.thinkingLevel, state: decision.state };
      },
    });
  }
};
