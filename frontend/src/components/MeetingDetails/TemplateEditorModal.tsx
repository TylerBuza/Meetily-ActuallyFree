'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type MessageKey } from '@/i18n';

type Format = 'paragraph' | 'list' | 'table' | 'string';

const FORMATS: Array<{ value: Format; label: MessageKey }> = [
  { value: 'list', label: 'summaries.formatList' },
  { value: 'paragraph', label: 'summaries.formatParagraph' },
  { value: 'table', label: 'summaries.formatTable' },
  { value: 'string', label: 'summaries.formatSingleLine' },
];

interface SectionDraft {
  title: string;
  instruction: string;
  format: Format;
  item_format?: string;
}

interface TemplateEditorModalProps {
  open: boolean;
  onClose: () => void;
  availableTemplates: Array<{ id: string; name: string; description: string }>;
  onSave: (templateId: string, templateJson: string) => Promise<string>;
  onDelete: (templateId: string) => Promise<void>;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

const emptySection = (): SectionDraft => ({ title: '', instruction: '', format: 'list' });

export function TemplateEditorModal({
  open,
  onClose,
  availableTemplates,
  onSave,
  onDelete,
}: TemplateEditorModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sections, setSections] = useState<SectionDraft[]>([emptySection()]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName('');
    setDescription('');
    setSections([emptySection()]);
  };

  const updateSection = (i: number, patch: Partial<SectionDraft>) => {
    setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const save = async () => {
    if (!name.trim()) return toast.error(t('summaries.templateNameRequired'));
    if (!description.trim()) return toast.error(t('summaries.templateDescriptionRequired'));
    const cleaned = sections
      .map((s) => ({ ...s, title: s.title.trim(), instruction: s.instruction.trim() }))
      .filter((s) => s.title && s.instruction);
    if (cleaned.length === 0) return toast.error(t('summaries.templateSectionRequired'));

    const template = {
      name: name.trim(),
      description: description.trim(),
      sections: cleaned.map((s) => {
        const out: any = { title: s.title, instruction: s.instruction, format: s.format };
        if (s.item_format && s.item_format.trim()) out.item_format = s.item_format.trim();
        return out;
      }),
    };

    const id = slugify(name);
    if (!id) return toast.error(t('summaries.templateNameInvalid'));

    setSaving(true);
    try {
      await onSave(id, JSON.stringify(template, null, 2));
      toast.success(t('summaries.templateSaved', { name }));
      reset();
      onClose();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : t('summaries.failedToSaveTemplate'));
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string, tname: string) => {
    try {
      await onDelete(id);
      toast.success(t('summaries.templateDeleted', { name: tname }));
    } catch (e) {
      const msg = typeof e === 'string' ? e : t('summaries.failedToDeleteTemplate');
      // Built-in templates aren't deletable and the backend returns "not found"
      toast.error(msg.includes('not found') ? t('summaries.builtInCannotDelete') : msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-w-2xl gap-5">
        <DialogHeader>
          <DialogTitle>{t('summaries.customTemplatesTitle')}</DialogTitle>
          <DialogDescription>{t('summaries.customTemplatesDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="template-name" className="text-xs font-medium text-af-text-2">
              {t('summaries.templateName')}
            </label>
            <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('summaries.templateNamePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="template-description" className="text-xs font-medium text-af-text-2">
              {t('summaries.description')}
            </label>
            <Input
              id="template-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('summaries.descriptionPlaceholder')}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-af-text-2">{t('summaries.sections')}</span>
            <Button variant="ghost" size="xs" onClick={() => setSections((p) => [...p, emptySection()])}>
              <Plus />
              {t('summaries.addSection')}
            </Button>
          </div>

          {sections.map((s, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-af-border p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={s.title}
                  onChange={(e) => updateSection(i, { title: e.target.value })}
                  placeholder={t('summaries.sectionTitlePlaceholder')}
                  aria-label={t('summaries.sectionTitle')}
                  className="flex-1"
                />
                <Select value={s.format} onValueChange={(value) => updateSection(i, { format: value as Format })}>
                  <SelectTrigger className="w-36 shrink-0" aria-label={t('summaries.sectionFormat')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((format) => (
                      <SelectItem key={format.value} value={format.value}>
                        {t(format.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sections.length > 1 && (
                  <IconButton
                    label={t('summaries.removeSection')}
                    icon={<X />}
                    tooltip={false}
                    className="shrink-0 text-af-text-3"
                    onClick={() => setSections((p) => p.filter((_, idx) => idx !== i))}
                  />
                )}
              </div>
              <Textarea
                value={s.instruction}
                onChange={(e) => updateSection(i, { instruction: e.target.value })}
                rows={2}
                placeholder={t('summaries.sectionInstructionPlaceholder')}
                aria-label={t('summaries.sectionInstruction')}
                className="resize-none"
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={reset} disabled={saving}>
            {t('summaries.clear')}
          </Button>
          <Button onClick={save} loading={saving}>
            {t('summaries.saveTemplate')}
          </Button>
        </DialogFooter>

        {availableTemplates.length > 0 && (
          <div className="border-t border-af-border pt-4">
            <h3 className="mb-1.5 text-[13px] font-semibold text-af-text">{t('summaries.yourTemplates')}</h3>
            <ul className="-mx-2">
              {availableTemplates.map((tpl) => (
                <li key={tpl.id} className="group/row flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-af-hover/60">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-af-text">{tpl.name}</div>
                    <div className="truncate text-xs text-af-text-3">{tpl.description}</div>
                  </div>
                  <IconButton
                    label={t('summaries.deleteTemplate', { name: tpl.name })}
                    icon={<Trash2 />}
                    variant="danger-ghost"
                    size="icon-xs"
                    tooltip={false}
                    className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                    onClick={() => del(tpl.id, tpl.name)}
                  />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-af-text-4">
              {t('summaries.builtInTemplatesNote')}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TemplateEditorModal;
