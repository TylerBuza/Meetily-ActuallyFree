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
        merging.length === 1 ? `${merging[0].displayName} merged into ${keep.displayName}` : `${merging.length} contacts merged into ${keep.displayName}`,
      );
      if (result) onMerged?.(result);
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not merge the contacts', { description: error instanceof Error ? error.message : String(error) });
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
          <DialogTitle>{single ? `Merge ${chosen[0]?.displayName ?? 'contact'} into…` : `Merge ${chosen.length} contacts`}</DialogTitle>
          <DialogDescription>
            Meetings, speaker names, action items and notes all move to the contact you keep. The others are removed.
          </DialogDescription>
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
                placeholder="Choose a contact"
                searchPlaceholder="Find a contact"
                emptyText="No other contacts"
                triggerClassName="w-full"
              />
            </div>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Contact to keep" className="space-y-1.5">
            <p className="text-xs font-medium text-af-text-2">Keep</p>
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
                    {[person.role, person.company, `${person.meetingCount} meeting${person.meetingCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {keepId === person.id && <span className="text-[11px] font-medium text-af-accent">Keep</span>}
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void run()} loading={saving} disabled={!keep || merging.length === 0}>
            {keep ? `Merge into ${keep.displayName}` : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
