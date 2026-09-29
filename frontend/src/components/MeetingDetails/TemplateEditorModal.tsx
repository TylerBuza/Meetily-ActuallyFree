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

type Format = 'paragraph' | 'list' | 'table' | 'string';

const FORMATS: Array<{ value: Format; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'table', label: 'Table' },
  { value: 'string', label: 'Single line' },
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
    if (!name.trim()) return toast.error('Template name is required');
    if (!description.trim()) return toast.error('Template description is required');
    const cleaned = sections
      .map((s) => ({ ...s, title: s.title.trim(), instruction: s.instruction.trim() }))
      .filter((s) => s.title && s.instruction);
    if (cleaned.length === 0) return toast.error('Add at least one section with a title and instruction');

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
    if (!id) return toast.error('Template name must contain letters or numbers');

    setSaving(true);
    try {
      await onSave(id, JSON.stringify(template, null, 2));
      toast.success(`Template "${name}" saved`);
      reset();
      onClose();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string, tname: string) => {
    try {
      await onDelete(id);
      toast.success(`Deleted "${tname}"`);
    } catch (e) {
      const msg = typeof e === 'string' ? e : 'Failed to delete';
      // Built-in templates aren't deletable and the backend returns "not found"
      toast.error(msg.includes('not found') ? 'Built-in templates cannot be deleted' : msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-w-2xl gap-5">
        <DialogHeader>
          <DialogTitle>Custom summary templates</DialogTitle>
          <DialogDescription>Choose the sections a summary has and how the model writes each one.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="template-name" className="text-xs font-medium text-af-text-2">
              Template name
            </label>
            <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Client discovery call" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="template-description" className="text-xs font-medium text-af-text-2">
              Description
            </label>
            <Input
              id="template-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this template for?"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-af-text-2">Sections</span>
            <Button variant="ghost" size="xs" onClick={() => setSections((p) => [...p, emptySection()])}>
              <Plus />
              Add section
            </Button>
          </div>

          {sections.map((s, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-af-border p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={s.title}
                  onChange={(e) => updateSection(i, { title: e.target.value })}
                  placeholder="Section title, e.g. Action items"
                  aria-label="Section title"
                  className="flex-1"
                />
                <Select value={s.format} onValueChange={(value) => updateSection(i, { format: value as Format })}>
                  <SelectTrigger className="w-36 shrink-0" aria-label="Section format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((format) => (
                      <SelectItem key={format.value} value={format.value}>
                        {format.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sections.length > 1 && (
                  <IconButton
                    label="Remove section"
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
                placeholder="What should the model write here? e.g. List each action item with its owner."
                aria-label="Section instruction"
                className="resize-none"
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={reset} disabled={saving}>
            Clear
          </Button>
          <Button onClick={save} loading={saving}>
            Save template
          </Button>
        </DialogFooter>

        {availableTemplates.length > 0 && (
          <div className="border-t border-af-border pt-4">
            <h3 className="mb-1.5 text-[13px] font-semibold text-af-text">Your templates</h3>
            <ul className="-mx-2">
              {availableTemplates.map((t) => (
                <li key={t.id} className="group/row flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-af-hover/60">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-af-text">{t.name}</div>
                    <div className="truncate text-xs text-af-text-3">{t.description}</div>
                  </div>
                  <IconButton
                    label={`Delete ${t.name}`}
                    icon={<Trash2 />}
                    variant="danger-ghost"
                    size="icon-xs"
                    tooltip={false}
                    className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                    onClick={() => del(t.id, t.name)}
                  />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-af-text-4">
              Built-in templates can&apos;t be deleted. Saving a template with the same name as a built-in replaces it.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TemplateEditorModal;
