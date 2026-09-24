import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { user_custom_providers } from '@kilocode/db/schema';
import {
  UserCustomProviderCreateSchema,
  UserCustomProviderUpdateSchema,
  UserCustomProviderListItemSchema,
} from '@/lib/ai-gateway/byok/types';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { encryptApiKey, decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';

const GENERIC_TEST_FAILURE_MESSAGE = 'API key test failed. Check the credential and try again.';

const ListUserCustomProvidersInputSchema = z.object({
  organizationId: z.string().uuid().optional(),
});

const DeleteUserCustomProviderInputSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid().optional(),
});

const TestCustomProviderSchema = z.object({
  provider_id: z.string(),
  base_url: z.string().url(),
  api_key: z.string().min(1),
});

async function testCustomProviderCredentials(
  providerId: string,
  baseUrl: string,
  apiKey: string
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: providerId,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => null);
      return {
        success: false,
        message: `API error: ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    if (data.error) {
      return { success: false, message: `API error: ${data.error.message || data.error}` };
    }

    return { success: true, message: 'API key test successful.' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, message: `API key test failed: ${message}` };
  }
}

export const customProvidersRouter = createTRPCRouter({
  list: baseProcedure
    .input(ListUserCustomProvidersInputSchema)
    .output(z.array(UserCustomProviderListItemSchema))
    .query(async ({ input, ctx }) => {
      const { organizationId } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      const keys = await db
        .select({
          id: user_custom_providers.id,
          provider_id: user_custom_providers.provider_id,
          display_name: user_custom_providers.display_name,
          base_url: user_custom_providers.base_url,
          is_enabled: user_custom_providers.is_enabled,
          models: user_custom_providers.models,
          created_at: user_custom_providers.created_at,
          updated_at: user_custom_providers.updated_at,
        })
        .from(user_custom_providers)
        .where(
          organizationId
            ? and(
                eq(user_custom_providers.organization_id, organizationId),
                eq(user_custom_providers.is_enabled, true)
              )
            : and(
                eq(user_custom_providers.kilo_user_id, ctx.user.id),
                eq(user_custom_providers.is_enabled, true)
              )
        )
        .orderBy(user_custom_providers.display_name);

      return keys;
    }),

  create: baseProcedure
    .input(
      UserCustomProviderCreateSchema.extend({
        organizationId: z.string().uuid().optional(),
      })
    )
    .output(UserCustomProviderListItemSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, provider_id, display_name, base_url, api_key, models, is_enabled } =
        input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);

      const [newKey] = await db
        .insert(user_custom_providers)
        .values({
          organization_id: organizationId ?? null,
          kilo_user_id: organizationId ? null : ctx.user.id,
          provider_id,
          display_name,
          base_url,
          api_key_encrypted: encrypted,
          models: models || [],
          is_enabled,
          created_by: ctx.user.id,
        })
        .returning({
          id: user_custom_providers.id,
          provider_id: user_custom_providers.provider_id,
          display_name: user_custom_providers.display_name,
          base_url: user_custom_providers.base_url,
          is_enabled: user_custom_providers.is_enabled,
          models: user_custom_providers.models,
          created_at: user_custom_providers.created_at,
          updated_at: user_custom_providers.updated_at,
        });

      if (organizationId) {
        await createAuditLog({
          action: 'organization.custom_provider.create',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Added custom provider: ${provider_id}`,
          organization_id: organizationId,
        });
      }

      return newKey;
    }),

  update: baseProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        organizationId: z.string().uuid().optional(),
        display_name: z.string().trim().min(1),
        base_url: z.string().url(),
        api_key: z.string().min(1).optional(),
        models: z.array(z.string()).default([]),
        is_enabled: z.boolean(),
      })
    )
    .output(UserCustomProviderListItemSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, organizationId, display_name, base_url, api_key, models, is_enabled } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      const [existingKey] = await db
        .select({
          organization_id: user_custom_providers.organization_id,
          kilo_user_id: user_custom_providers.kilo_user_id,
          provider_id: user_custom_providers.provider_id,
        })
        .from(user_custom_providers)
        .where(eq(user_custom_providers.id, id));

      if (!existingKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom provider not found' });
      }

      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom provider not found' });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom provider not found' });
        }
      }

      const updateData: Record<string, any> = { display_name, base_url, models, is_enabled };

      if (api_key) {
        updateData.api_key_encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);
      }

      const [updatedKey] = await db
        .update(user_custom_providers)
        .set(updateData)
        .where(eq(user_custom_providers.id, id))
        .returning({
          id: user_custom_providers.id,
          provider_id: user_custom_providers.provider_id,
          display_name: user_custom_providers.display_name,
          base_url: user_custom_providers.base_url,
          is_enabled: user_custom_providers.is_enabled,
          models: user_custom_providers.models,
          created_at: user_custom_providers.created_at,
          updated_at: user_custom_providers.updated_at,
        });

      if (organizationId) {
        await createAuditLog({
          action: 'organization.custom_provider.update',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Updated custom provider: ${existingKey.provider_id}`,
          organization_id: organizationId,
        });
      }

      return updatedKey;
    }),

  delete: baseProcedure
    .input(DeleteUserCustomProviderInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { id, organizationId } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_BILLING_ROLES);
      }

      const [existingKey] = await db
        .select({
          organization_id: user_custom_providers.organization_id,
          kilo_user_id: user_custom_providers.kilo_user_id,
          provider_id: user_custom_providers.provider_id,
        })
        .from(user_custom_providers)
        .where(eq(user_custom_providers.id, id));

      if (!existingKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom provider not found' });
      }

      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom provider not found' });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom provider not found' });
        }
      }

      await db.delete(user_custom_providers).where(eq(user_custom_providers.id, id));

      if (organizationId) {
        await createAuditLog({
          action: 'organization.custom_provider.delete',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Deleted custom provider: ${existingKey.provider_id}`,
          organization_id: organizationId,
        });
      }

      return { success: true };
    }),

  test: baseProcedure
    .input(TestCustomProviderSchema)
    .output(z.object({ success: z.boolean(), message: z.string() }))
    .mutation(async ({ input }) => {
      const { provider_id, base_url, api_key } = input;
      return testCustomProviderCredentials(provider_id, base_url, api_key);
    }),
});
