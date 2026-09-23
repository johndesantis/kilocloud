'use client';

import { useState } from 'react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Trash2,
  Edit,
  Plus,
  Info,
  Lock,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  UserCustomProviderCreateSchema,
  UserCustomProviderUpdateSchema,
  type UserCustomProviderListItem,
} from '@/lib/ai-gateway/byok/types';
import * as z from 'zod';

type CustomProviderDialogState = {
  isOpen: boolean;
  editingId: string | null;
};

const INITIAL_DIALOG_STATE: CustomProviderDialogState = {
  isOpen: false,
  editingId: null,
};

type CustomProvidersManagerProps = {
  organizationId?: string;
};

export function CustomProvidersManager({ organizationId }: CustomProvidersManagerProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [dialogState, setDialogState] = useState<CustomProviderDialogState>(INITIAL_DIALOG_STATE);

  const listInput = organizationId ? { organizationId } : {};

  const { data: keys, isLoading: keysLoading } = useQuery(
    trpc.customProviders.list.queryOptions(listInput)
  );

  const createMutation = useMutation({
    ...trpc.customProviders.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.customProviders.list.queryKey(listInput) });
        setDialogState(INITIAL_DIALOG_STATE);
        toast.success('Custom provider added');
      },
      onError: (err) => {
        toast.error(err.message ?? 'Failed to add custom provider');
      },
    }),
  });

  const updateMutation = useMutation({
    ...trpc.customProviders.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.customProviders.list.queryKey(listInput) });
        setDialogState(INITIAL_DIALOG_STATE);
        toast.success('Custom provider updated');
      },
      onError: (err) => {
        toast.error(err.message ?? 'Failed to update custom provider');
      },
    }),
  });

  const deleteMutation = useMutation({
    ...trpc.customProviders.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.customProviders.list.queryKey(listInput) });
        toast.success('Custom provider deleted');
      },
      onError: (err) => {
        toast.error(err.message ?? 'Failed to delete custom provider');
      },
    }),
  });

  const handleToggleEnabled = (id: string, is_enabled: boolean) => {
    const current = keys?.find((key) => key.id === id);
    if (!current) return;

    updateMutation.mutate(
      {
        id,
        ...(organizationId ? { organizationId } : {}),
        display_name: current.display_name,
        base_url: current.base_url,
        models: current.models ?? [],
        is_enabled,
      },
      {
        onSuccess: () => {
          toast.success(is_enabled ? 'Provider enabled' : 'Provider disabled');
        },
      }
    );
  };

  const handleDelete = async (id: string, providerId: string) => {
    const confirmed = await confirm({
      title: 'Delete custom provider',
      message: `Are you sure you want to delete "${providerId}"? This action cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    deleteMutation.mutate(
      { id, ...(organizationId ? { organizationId } : {}) },
      {
        onSuccess: () => {
          toast.success('Custom provider deleted');
        },
      }
    );
  };

  const handleSubmit = (
    values: z.infer<typeof UserCustomProviderCreateSchema> | z.infer<typeof UserCustomProviderUpdateSchema>
  ) => {
    if (dialogState.editingId) {
      updateMutation.mutate({
        id: dialogState.editingId,
        ...(organizationId ? { organizationId } : {}),
        ...values,
      });
    } else {
      createMutation.mutate({
        ...(organizationId ? { organizationId } : {}),
        ...values,
      });
    }
  };

  if (keysLoading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Custom AI Providers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground">Loading&hellip;</div>
          </CardContent>
          <CardFooter>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Info className="size-4" />
              Add your own AI providers with custom API keys and base URLs
            </div>
          </CardFooter>
        </Card>
      </div>
    );
  }

  const listedKeys = keys ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
          <div className="flex flex-col gap-2">
            <CardTitle>Custom AI Providers</CardTitle>
          </div>
          <Button
            onClick={() =>
              setDialogState({ isOpen: true, editingId: null })
            }
            size="sm"
          >
            <Plus className="mr-2 size-4" />
            Add Provider
          </Button>
        </CardHeader>
        <CardContent>
          {listedKeys.length > 0 ? (
            <div className="rounded-md border">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="p-4 text-left font-medium">Provider</th>
                    <th className="p-4 text-left font-medium">Base URL</th>
                    <th className="p-4 text-left font-medium">Models</th>
                    <th className="p-4 text-left font-medium">Enabled</th>
                    <th className="p-4 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {listedKeys.map((key: UserCustomProviderListItem) => (
                    <tr
                      key={key.id}
                      className={
                        !key.is_enabled ? 'bg-muted/20 border-b last:border-0' : 'border-b last:border-0'
                      }
                    >
                      <td className={!key.is_enabled ? 'text-muted-foreground p-4' : 'p-4'}>
                        <div className="font-medium">{key.display_name}</div>
                        <div className="text-muted-foreground text-xs">{key.provider_id}</div>
                      </td>
                      <td className={!key.is_enabled ? 'text-muted-foreground p-4' : 'p-4'}>
                        <div className="text-sm font-mono max-w-[200px] truncate">{key.base_url}</div>
                      </td>
                      <td className={!key.is_enabled ? 'text-muted-foreground p-4' : 'p-4'}>
                        <div className="flex flex-wrap gap-1">
                          {key.models?.slice(0, 3).map((m) => (
                            <span key={m} className="text-xs bg-muted rounded px-1.5 py-0.5">
                              {m}
                            </span>
                          ))}
                          {key.models && key.models.length > 3 && (
                            <span className="text-xs text-muted-foreground">
                              +{key.models.length - 3} more
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={!key.is_enabled ? 'text-muted-foreground p-4' : 'p-4'}>
                        <Switch
                          checked={key.is_enabled}
                          onCheckedChange={(checked) => handleToggleEnabled(key.id, checked)}
                          disabled={updateMutation.isPending}
                          size="sm"
                        />
                      </td>
                      <td className={!key.is_enabled ? 'text-muted-foreground p-4' : 'p-4'}>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() =>
                              setDialogState({
                                isOpen: true,
                                editingId: key.id,
                              })
                            }
                            className="p-1 hover:bg-muted rounded"
                            title="Edit"
                          >
                            <Edit className="size-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(key.id, key.provider_id)}
                            className="p-1 hover:bg-destructive/10 rounded text-destructive"
                            title="Delete"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-muted-foreground py-4">No custom providers configured</div>
          )}
        </CardContent>
        <CardFooter>
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Lock className="size-4" />
            Your API keys are encrypted and stored securely
          </div>
        </CardFooter>
      </Card>

      <Dialog
        open={dialogState.isOpen}
        onOpenChange={(open) =>
          setDialogState({ isOpen: open, editingId: open ? dialogState.editingId : null })
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogState.editingId ? 'Edit Custom Provider' : 'Add Custom Provider'}
            </DialogTitle>
          </DialogHeader>
          <CustomProviderForm
            initialData={
              dialogState.editingId
                ? listedKeys.find((k) => k.id === dialogState.editingId)
                : null
            }
            onSubmit={handleSubmit}
            onCancel={() => setDialogState(INITIAL_DIALOG_STATE)}
            isSubmitting={createMutation.isPending || updateMutation.isPending}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

type CustomProviderFormProps = {
  initialData: UserCustomProviderListItem | null;
  onSubmit: (values: z.infer<typeof UserCustomProviderCreateSchema> | z.infer<typeof UserCustomProviderUpdateSchema>) => void;
  onCancel: () => void;
  isSubmitting: boolean;
};

function CustomProviderForm({
  initialData,
  onSubmit,
  onCancel,
  isSubmitting,
}: CustomProviderFormProps) {
  const [providerId, setProviderId] = useState(initialData?.provider_id ?? '');
  const [displayName, setDisplayName] = useState(initialData?.display_name ?? '');
  const [baseUrl, setBaseUrl] = useState(initialData?.base_url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(
    initialData?.models?.join(', ') ?? ''
  );
  const [isEnabled, setIsEnabled] = useState(initialData?.is_enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};
    if (!providerId.trim()) newErrors.providerId = 'Provider ID is required';
    if (!displayName.trim()) newErrors.displayName = 'Display name is required';
    if (!baseUrl.trim()) newErrors.baseUrl = 'Base URL is required';
    if (!apiKey.trim() && !initialData) newErrors.apiKey = 'API key is required';
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    const isEditing = !!initialData;
    try {
      const result = isEditing
        ? UserCustomProviderUpdateSchema.parse({
            display_name: displayName.trim(),
            base_url: baseUrl.trim(),
            api_key: apiKey.trim() || undefined,
            models: models ? models.split(',').map((m) => m.trim()).filter(Boolean) : [],
            is_enabled: isEnabled,
          })
        : UserCustomProviderCreateSchema.parse({
            provider_id: providerId.trim(),
            display_name: displayName.trim(),
            base_url: baseUrl.trim(),
            api_key: apiKey.trim(),
            models: models ? models.split(',').map((m) => m.trim()).filter(Boolean) : [],
            is_enabled: isEnabled,
          });
      onSubmit(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of err.issues) {
          fieldErrors[issue.path[0] as string] = issue.message;
        }
        setErrors(fieldErrors);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="providerId">Provider ID</Label>
        <Input
          id="providerId"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          placeholder="my-custom-model"
          className={errors.providerId ? 'border-destructive' : ''}
        />
        {errors.providerId && <p className="text-xs text-destructive">{errors.providerId}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="displayName">Display Name</Label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="My Custom Provider"
          className={errors.displayName ? 'border-destructive' : ''}
        />
        {errors.displayName && <p className="text-xs text-destructive">{errors.displayName}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="baseUrl">Base URL</Label>
        <Input
          id="baseUrl"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className={errors.baseUrl ? 'border-destructive' : ''}
        />
        {errors.baseUrl && <p className="text-xs text-destructive">{errors.baseUrl}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="apiKey">API Key</Label>
        <Input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className={errors.apiKey ? 'border-destructive' : ''}
        />
        {errors.apiKey && <p className="text-xs text-destructive">{errors.apiKey}</p>}
        {initialData && (
          <p className="text-xs text-muted-foreground">
            Leave blank to keep existing key
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="models">Models (comma-separated)</Label>
        <Input
          id="models"
          value={models}
          onChange={(e) => setModels(e.target.value)}
          placeholder="gpt-4, claude-3"
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch id="isEnabled" checked={isEnabled} onCheckedChange={setIsEnabled} />
        <Label htmlFor="isEnabled">Enabled</Label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : initialData ? 'Update' : 'Add Provider'}
        </Button>
      </div>
    </form>
  );
}
