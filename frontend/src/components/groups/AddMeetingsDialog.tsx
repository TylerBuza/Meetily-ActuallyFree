'use client';

/** Pick existing meetings to file into a group. A meeting lives in one group, so ones elsewhere move. */
import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GroupChip } from '@/components/groups/GroupBits';
import { moveMeetingsToGroup } from '@/lib/meeting-actions';
import { displayTitle } from '@/lib/meeting-titles';
import { formatDuration, formatShortDate, parseDate } from '@/lib/dates';

export function AddMeetingsDialog({
  open,
  onOpenChange,
  group,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: { id: string; name: string };
}) {
  const { meetings } = useSidebar();
  const { groupById } = useWorkspace();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery('');
      setPicked(new Set());
    }
  }, [open]);

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return meetings
      .filter((meeting) => meeting.group_id !== group.id)
      .filter((meeting) => !needle || displayTitle(meeting.title, meeting.created_at).toLowerCase().includes(needle))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [meetings, group.id, query]);

  const moving = [...picked].filter((id) => meetings.find((meeting) => meeting.id === id)?.group_id).length;

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const add = async () => {
    setSaving(true);
    const ok = await moveMeetingsToGroup([...picked], group.id, group.name);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="px-6 pb-3 pt-6">
          <DialogTitle>Add meetings to {group.name}</DialogTitle>
          <DialogDescription>A meeting belongs to one group. Picking one that is already in another group moves it here.</DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-af-text-4" />
            <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find meetings" className="pl-9" />
          </div>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto border-y border-af-border px-3 py-2">
          {candidates.length === 0 ? (
            <li className="px-3 py-8 text-center text-[13px] text-af-text-3">
              {query.trim() ? 'No meetings match.' : 'Every meeting is already in this group.'}
            </li>
          ) : (
            candidates.map((meeting) => {
              const other = groupById(meeting.group_id);
              const date = parseDate(meeting.created_at);
              const checked = picked.has(meeting.id);
              return (
                <li key={meeting.id}>
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                      checked ? 'bg-af-accent/[0.1]' : 'hover:bg-af-hover',
                    )}
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggle(meeting.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-af-text">{displayTitle(meeting.title, meeting.created_at)}</span>
                      <span className="block truncate text-[11px] text-af-text-4">
                        {[date ? formatShortDate(date) : null, formatDuration(meeting.duration_seconds) || null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {other && <GroupChip group={other} size="xs" />}
                  </label>
                </li>
              );
            })
          )}
        </ul>
        <DialogFooter className="px-6 py-4">
          {moving > 0 && (
            <p className="mr-auto self-center text-xs text-af-text-3">
              {moving} will move from another group
            </p>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void add()} loading={saving} disabled={picked.size === 0}>
            {picked.size > 0 ? `Add ${picked.size} meeting${picked.size === 1 ? '' : 's'}` : 'Add meetings'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
