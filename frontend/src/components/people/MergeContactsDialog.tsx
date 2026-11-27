'use client';

/**
 * Merge duplicate contacts. Everything from the merged ones (meetings, speaker
 * names, action items, notes) moves onto the contact you keep.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { announceChange, mergePeople, type ContactRow } from '@/lib/workspace-api';
import { useI18n } from '@/i18n';

export function MergeContactsDialog({
  open,
  onOpenChange,
  personIds,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Two or more contacts to merge, or one to merge into someone else. */
  personIds: string[];
  onMerged?: (kept: ContactRow) => void;
}) {
  const { people, personById } = useWorkspace();
  const { t } = useI18n();
  const [keepId, setKeepId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const single = personIds.length === 1;

  const chosen = useMemo(() => personIds.map((id) => personById(id)).filter(Boolean) as ContactRow[], [personIds, personById]);

  useEffect(() => {
    if (!open) return;
    // Keep the contact with the most history by default.
    const best = [...chosen].sort((a, b) => b.meetingCount - a.meetingCount)[0];
    setKeepId(single ? null : best?.id ?? null);
  }, [open, chosen, single]);

  const keep = keepId ? personById(keepId) : null;
  const merging = single ? chosen : chosen.filter((person) => person.id !== keepId);

  const run = async () => {
    if (!keep || merging.length === 0) return;
    setSaving(true);
    try {
      let result: ContactRow | null = null;
      for (const person of merging) result = await mergePeople(person.id, keep.id);
      announceChange('people');
      announceChange('actions');
      toast.success(
        merging.length === 1
          ? t('people.mergedSingle', { source: merging[0].displayName, target: keep.displayName })
          : t('people.mergedMany', { count: merging.length, target: keep.displayName }),
      );
      if (result) onMerged?.(result);
      onOpenChange(false);
    } catch (error) {
      toast.error(t('people.couldNotMerge'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const targets = people
    .filter((person) => !personIds.includes(person.id))
    .map((person) => ({
      value: person.id,
      label: person.displayName,
      description: [person.role, person.company].filter(Boolean).join(' · ') || undefined,
      icon: <Avatar name={person.displayName} size="xs" />,
    }));

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {single
              ? t('people.mergeContactTitle', { name: chosen[0]?.displayName ?? t('people.contactFallback') })
              : t('people.mergeContactsTitle', { count: chosen.length })}
          </DialogTitle>
          <DialogDescription>{t('people.mergeDescription')}</DialogDescription>
        </DialogHeader>

        {single ? (
          <div className="flex items-center gap-3">
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-af-border bg-af-panel-2/60 px-3 py-2">
              <Avatar name={chosen[0]?.displayName ?? '?'} size="sm" />
              <span className="truncate text-[13px] text-af-text">{chosen[0]?.displayName}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-af-text-4" />
            <div className="min-w-0 flex-1">
              <Combobox
                value={keepId}
                onChange={(value) => setKeepId(value)}
                options={targets}
                placeholder={t('people.chooseContact')}
                searchPlaceholder={t('people.findContact')}
                emptyText={t('people.noOtherContacts')}
                triggerClassName="w-full"
              />
            </div>
          </div>
        ) : (
          <div role="radiogroup" aria-label={t('people.keepAria')} className="space-y-1.5">
            <p className="text-xs font-medium text-af-text-2">{t('people.keep')}</p>
            {chosen.map((person) => (
              <button
                key={person.id}
                type="button"
                role="radio"
                aria-checked={keepId === person.id}
                onClick={() => setKeepId(person.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                  keepId === person.id ? 'border-af-accent bg-af-accent/[0.08]' : 'border-af-border hover:bg-af-hover',
                )}
              >
                <Avatar name={person.displayName} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-af-text">{person.displayName}</span>
                  <span className="block truncate text-[11px] text-af-text-4">
                    {[
                      person.role,
                      person.company,
                      t(person.meetingCount === 1 ? 'people.meetingCountOne' : 'people.meetingCountMany', { count: person.meetingCount }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {keepId === person.id && <span className="text-[11px] font-medium text-af-accent">{t('people.keep')}</span>}
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void run()} loading={saving} disabled={!keep || merging.length === 0}>
            {keep ? t('people.mergeIntoNamed', { name: keep.displayName }) : t('people.merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
