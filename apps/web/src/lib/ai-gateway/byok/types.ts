import { UserByokProviderIdSchema } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import * as z from 'zod';

// API response type (never includes decrypted key)
export type BYOKApiKeyResponse = {
  id: string;
  provider_id: string;
  provider_name: string;
  management_source: 'user' | 'coding_plan';
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
};

// User custom provider schemas
export type UserCustomProviderResponse = {
  id: string;
  provider_id: string;
  display_name: string;
  base_url: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  models?: string[];
};

// Optional organization ID schema - when not provided, uses the authenticated user's ID
const OptionalOrganizationIdSchema = z.object({
  organizationId: z.string().uuid().optional(),
});

// Zod schemas for tRPC validation
// Note: organizationId is optional - if provided, enforces org owner/billing access
// If not provided, uses the authenticated user's kilo_user_id
export const CreateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  provider_id: UserByokProviderIdSchema,
  api_key: z.string().min(1),
});

export const UpdateBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
  api_key: z.string().min(1),
});

export const DeleteBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
});

export const SetBYOKKeyEnabledInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
  is_enabled: z.boolean(),
});

// List schema with optional organizationId
export const ListBYOKKeysInputSchema = OptionalOrganizationIdSchema;

export const TestBYOKKeyInputSchema = OptionalOrganizationIdSchema.extend({
  id: z.string().uuid(),
});

export const BYOKApiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  provider_id: z.string(),
  provider_name: z.string(),
  management_source: z.enum(['user', 'coding_plan']),
  is_enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
});

export const UserCustomProviderCreateSchema = z.object({
  provider_id: z.string().min(1),
  display_name: z.string().trim().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1),
  models: z.array(z.string()).default([]),
});

export const UserCustomProviderUpdateSchema = z.object({
  display_name: z.string().trim().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1).optional(),
  models: z.array(z.string()).default([]),
  is_enabled: z.boolean(),
});

export const UserCustomProviderListItemSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  display_name: z.string(),
  base_url: z.string(),
  is_enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type UserCustomProviderListItem = z.infer<
  typeof UserCustomProviderListItemSchema
>;

export const UserCustomProviderTestSchema = z.object({
  provider_id: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1),
});
