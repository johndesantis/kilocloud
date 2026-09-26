import { user_custom_providers } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export async function listAvailableUserCustomProvidersForOrganization(
  organizationId: string
): Promise<OpenRouterModel[]> {
  return listAvailableUserCustomProviders(organizationId, undefined);
}

export async function listAvailableUserCustomProvidersForUser(
  kiloUserId: string
): Promise<OpenRouterModel[]> {
  return listAvailableUserCustomProviders(undefined, kiloUserId);
}

async function listAvailableUserCustomProviders(
  organizationId: string | undefined,
  kiloUserId: string | undefined
): Promise<OpenRouterModel[]> {
  if (!organizationId && !kiloUserId) {
    return [];
  }

  const conditions = [];
  if (organizationId) {
    conditions.push(eq(user_custom_providers.organization_id, organizationId));
  } else if (kiloUserId) {
    conditions.push(eq(user_custom_providers.kilo_user_id, kiloUserId));
  }

  const rows = await readDb
    .select({
      id: user_custom_providers.id,
      provider_id: user_custom_providers.provider_id,
      display_name: user_custom_providers.display_name,
      base_url: user_custom_providers.base_url,
      models: user_custom_providers.models,
      is_enabled: user_custom_providers.is_enabled,
    })
    .from(user_custom_providers)
    .where(and(...conditions, eq(user_custom_providers.is_enabled, true)));

  const models: OpenRouterModel[] = [];

  for (const row of rows) {
    const providerId = row.provider_id;
    const displayName = row.display_name;
    const modelIds = (row.models as string[]) ?? [];

    for (const modelId of modelIds) {
      const model: OpenRouterModel = {
        id: `${providerId}/${modelId}`,
        name: `${displayName}: ${modelId}`,
        created: Math.floor(Date.now() / 1000),
        description: `Custom provider: ${displayName}`,
        architecture: {
          modality: 'text->text',
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'Other',
        },
        top_provider: {
          context_length: 128000,
          max_completion_tokens: 8192,
          is_moderated: false,
        },
        context_length: 128000,
        pricing: {
          prompt: '0.0000000',
          completion: '0.0000000',
          request: '0',
          image: '0',
          web_search: '0',
          internal_reasoning: '0',
          input_cache_read: '0.00000000',
          input_cache_write: '0.00000000',
        },
        per_request_limits: null,
        supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
        mayTrainOnYourPrompts: true,
        opencode: {
          ai_sdk_provider: 'openai-compatible',
        },
      };
      models.push(model);
    }
  }

  return models;
}