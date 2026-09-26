/**
 * Hook for fetching and filtering organization models
 *
 * Handles fetching organization configuration and available models.
 */

import { useMemo } from 'react';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { buildContextLengthByModelId } from '@/components/cloud-agent-next/model-context-lengths';
import { useUserCustomProviders } from './useUserCustomProviders';

type UseOrganizationModelsReturn = {
  /** Models formatted for the ModelCombobox component */
  modelOptions: ModelOption[];
  /** Whether models are still loading */
  isLoadingModels: boolean;
  /** Context windows keyed by exact catalog model ID */
  contextLengthByModelId: ReadonlyMap<string, number>;
  /** The organization's default model */
  defaultModel: string | undefined;
};

/**
 * Fetches and filters models based on organization configuration.
 *
 * If organizationId is provided, the models API applies org access policy.
 *
 * @param organizationId - Optional organization ID to filter models for
 * @param enabled - Whether the Gateway model catalog should be fetched
 */
export function useOrganizationModels(
  organizationId?: string,
  enabled = true
): UseOrganizationModelsReturn {
  // Fetch models for the model selector
  const { data: openRouterModels, isLoading: isLoadingOpenRouter } = useModelSelectorList(
    organizationId,
    enabled
  );

  // Fetch user custom providers for provider group display names
  const { data: userCustomProviders } = useUserCustomProviders(organizationId);

  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  // Build a map of provider ID to display name for custom providers
  const customProviderDisplayNames = useMemo(
    () =>
      new Map(
        (userCustomProviders ?? []).map(p => [p.provider_id, p.display_name])
      ),
    [userCustomProviders]
  );

  // Format models for the combobox
  const modelOptions = useMemo<ModelOption[]>(() => {
    return (
      openRouterModels?.data.map(model => {
        // Extract provider from model ID (format: provider/model)
        const providerId = model.id.split('/')[0];
        const providerDisplayName = customProviderDisplayNames.get(providerId);

        return {
          id: model.id,
          name: model.name,
          isFree: model.isFree,
          mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
          hasUserByokAvailable: model.hasUserByokAvailable,
          variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
          providerGroup: providerDisplayName
            ? { id: providerId, label: providerDisplayName }
            : providerId
              ? { id: providerId, label: providerId }
              : undefined,
        };
      }) ?? []
    );
  }, [openRouterModels, customProviderDisplayNames]);

  const contextLengthByModelId = useMemo(
    () => buildContextLengthByModelId(openRouterModels?.data ?? []),
    [openRouterModels]
  );

  return {
    modelOptions,
    isLoadingModels: enabled && isLoadingOpenRouter,
    contextLengthByModelId,
    defaultModel: defaultsData?.defaultModel,
  };
}
