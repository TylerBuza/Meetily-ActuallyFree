'use client';

import { useState } from 'react';
import { toast } from 'sonner';

type Format = 'paragraph' | 'list' | 'table' | 'string';

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

  if (!open) return null;

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="text-lg font-semibold text-gray-800">Custom summary templates</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Create form */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Template name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Client Discovery Call"
                  className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Description</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this template for?"
                  className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-gray-600">Sections</label>
                <button
                  onClick={() => setSections((p) => [...p, emptySection()])}
                  className="rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
                >
                  ＋ Add section
                </button>
              </div>

              {sections.map((s, i) => (
                <div key={i} className="rounded-lg border border-gray-200 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      value={s.title}
                      onChange={(e) => updateSection(i, { title: e.target.value })}
                      placeholder="Section title (e.g. Action Items)"
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
                    />
                    <select
                      value={s.format}
                      onChange={(e) => updateSection(i, { format: e.target.value as Format })}
                      className="rounded border border-gray-200 px-2 py-1 text-sm"
                      title="How the model should format this section"
                    >
                      <option value="list">List</option>
                      <option value="paragraph">Paragraph</option>
                      <option value="table">Table</option>
                      <option value="string">Single line</option>
                    </select>
                    {sections.length > 1 && (
                      <button
                        onClick={() => setSections((p) => p.filter((_, idx) => idx !== i))}
                        className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                        title="Remove section"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <textarea
                    value={s.instruction}
                    onChange={(e) => updateSection(i, { instruction: e.target.value })}
                    rows={2}
                    placeholder="Instruction for the AI — e.g. 'List concrete action items with an owner'"
                    className="w-full resize-none rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={reset} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">
                Clear
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-300"
              >
                {saving ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </div>

          {/* Existing templates */}
          <div className="mt-6 border-t border-gray-100 pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Your templates
            </h3>
            <div className="space-y-1">
              {availableTemplates.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-gray-50">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-gray-800">{t.name}</div>
                    <div className="truncate text-xs text-gray-400">{t.description}</div>
                  </div>
                  <button
                    onClick={() => del(t.id, t.name)}
                    className="ml-3 shrink-0 rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                    title="Delete (custom templates only)"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-400">
              Built-in templates can&apos;t be deleted. Saving a template with the same name as a built-in overrides it.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TemplateEditorModal;
