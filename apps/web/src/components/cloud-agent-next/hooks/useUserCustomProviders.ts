'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { UserCustomProviderListItem } from '@/lib/ai-gateway/byok/types';

export function useUserCustomProviders(organizationId?: string) {
  const trpc = useTRPC();

  const listInput = organizationId ? { organizationId } : {};

  const { data, isLoading } = useQuery(
    trpc.customProviders.list.queryOptions(listInput)
  );

  return {
    data: (data as UserCustomProviderListItem[]) ?? [],
    isLoading,
  };
}