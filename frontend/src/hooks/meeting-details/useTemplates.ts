import { useState, useEffect, useCallback } from 'react';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';

export function useTemplates() {
  const [availableTemplates, setAvailableTemplates] = useState<Array<{
    id: string;
    name: string;
    description: string;
  }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('standard_meeting');

  const refreshTemplates = useCallback(async () => {
    try {
      const templates = await invokeTauri('api_list_templates') as Array<{
        id: string;
        name: string;
        description: string;
      }>;
      setAvailableTemplates(templates);
      return templates;
    } catch (error) {
      console.error('Failed to fetch templates:', error);
      return [];
    }
  }, []);

  // Fetch available templates on mount
  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  // Create or overwrite a custom template. `templateJson` must match the template schema.
  const saveCustomTemplate = useCallback(async (templateId: string, templateJson: string) => {
    const savedId = await invokeTauri('api_save_custom_template', {
      templateId,
      templateJson,
    }) as string;
    await refreshTemplates();
    Analytics.trackFeatureUsed('template_saved');
    return savedId;
  }, [refreshTemplates]);

  // Delete a custom template (built-ins are not deletable).
  const deleteCustomTemplate = useCallback(async (templateId: string) => {
    await invokeTauri('api_delete_custom_template', { templateId });
    await refreshTemplates();
    Analytics.trackFeatureUsed('template_deleted');
    if (selectedTemplate === templateId) setSelectedTemplate('standard_meeting');
  }, [refreshTemplates, selectedTemplate]);

  const isCustomTemplate = useCallback(async (templateId: string): Promise<boolean> => {
    try {
      return await invokeTauri('api_is_custom_template', { templateId }) as boolean;
    } catch {
      return false;
    }
  }, []);

  // Handle template selection
  const handleTemplateSelection = useCallback((templateId: string, templateName: string) => {
    setSelectedTemplate(templateId);
    toast.success('Template selected', {
      description: `Using "${templateName}" template for summary generation`,
    });
    Analytics.trackFeatureUsed('template_selected');
  }, []);

  return {
    availableTemplates,
    selectedTemplate,
    handleTemplateSelection,
    refreshTemplates,
    saveCustomTemplate,
    deleteCustomTemplate,
    isCustomTemplate,
  };
}
