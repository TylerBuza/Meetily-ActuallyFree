'use client';

/**
 * Everyone you've named in a meeting, plus people you added yourself. Search,
 * sort, and tidy up: add, edit, merge duplicates, delete.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowUpRight, Contact, GitMerge, MoreHorizontal, Pencil, Search, Trash2, UserPlus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GroupChip } from '@/components/groups/GroupBits';
import { ContactDialog } from '@/components/people/ContactDialog';
import { MergeContactsDialog } from '@/components/people/MergeContactsDialog';
import { announceChange, deletePerson, type ContactRow } from '@/lib/workspace-api';
import { formatRelativePast, parseDate } from '@/lib/dates';

type Sort = 'recent' | 'name' | 'meetings';

function ContactsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { people, peopleLoaded } = useWorkspace();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ContactRow | null | 'new'>(null);
  const [merging, setMerging] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);

  // "New contact" from the command bar or home page.
  useEffect(() => {
    if (params.get('new') === '1') {
      setEditing('new');
      router.replace('/contacts');
    }
  }, [params, router]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? people.filter((person) =>
          [person.displayName, person.role, person.company, person.email]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(needle)),
        )
      : [...people];
    return list.sort((a, b) => {
      if (sort === 'name') return a.displayName.localeCompare(b.displayName);
      if (sort === 'meetings') return b.meetingCount - a.meetingCount || a.displayName.localeCompare(b.displayName);
      return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || a.displayName.localeCompare(b.displayName);
    });
  }, [people, query, sort]);

  useEffect(() => {
    const alive = new Set(people.map((person) => person.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [people]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selecting = selected.size > 0;

  return (
    <div className="h-full overflow-y-auto bg-af-panel">
      <div className="mx-auto w-full max-w-5xl px-8 pb-32 pt-10 animate-af-rise">
        <PageHeader
          title="Contacts"
          description="Everyone you've named in a meeting, and anyone you add yourself. Pick them when naming speakers, and their meetings and action items gather on their page."
          actions={
            <Button size="sm" onClick={() => setEditing('new')}>
              <UserPlus />
              New contact
            </Button>
          }
        />

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-af-text-4" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, role, company or email"
              className="pl-9"
              aria-label="Search contacts"
            />
          </div>
          <Select value={sort} onValueChange={(value) => setSort(value as Sort)}>
            <SelectTrigger className="w-44" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recently met</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="meetings">Most meetings</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mt-5">
          {!peopleLoaded ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : people.length === 0 ? (
            <EmptyState
              icon={<Contact />}
              title="No contacts yet"
              description="Name a speaker in any meeting and they become a contact. You can also add people before you meet them."
              action={
                <Button onClick={() => setEditing('new')}>
                  <UserPlus />
                  New contact
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState icon={<Search />} title="No one matches" description="Try part of a name, a company or an email." />
          ) : (
            <ul className="af-appear overflow-hidden rounded-xl border border-af-border bg-af-panel-2/40">
              {shown.map((person) => {
                const seen = parseDate(person.lastSeenAt);
                const checked = selected.has(person.id);
                return (
                  <li
                    key={person.id}
                    onClick={() => (selecting ? toggle(person.id) : router.push(`/person?id=${encodeURIComponent(person.id)}`))}
                    className={cn(
                      'group/row grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-af-border px-3 py-2.5 transition-colors last:border-b-0 md:grid-cols-[1.25rem_minmax(0,1fr)_13rem_9.5rem_1.75rem]',
                      checked ? 'bg-af-accent/[0.1]' : 'hover:bg-af-hover/70',
                    )}
                  >
                    <span onClick={(event) => event.stopPropagation()} className="flex items-center">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(person.id)}
                        aria-label={checked ? `Deselect ${person.displayName}` : `Select ${person.displayName}`}
                        className={cn('transition-opacity', selecting || checked ? 'opacity-100' : 'opacity-40 group-hover/row:opacity-100')}
                      />
                    </span>
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={person.displayName} size="md" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-af-text">{person.displayName}</span>
                        <span className="block truncate text-xs text-af-text-3">
                          {[person.role, person.company].filter(Boolean).join(' · ') || person.email || `${person.meetingCount} meeting${person.meetingCount === 1 ? '' : 's'}`}
                        </span>
                      </span>
                    </span>
                    <span className="hidden min-w-0 flex-wrap gap-1 md:flex">
                      {person.groups.slice(0, 2).map((group) => (
                        <GroupChip key={group.id} group={group} size="xs" />
                      ))}
                      {person.groups.length > 2 && <span className="text-[11px] text-af-text-4">+{person.groups.length - 2}</span>}
                    </span>
                    <span className="hidden text-right text-xs tabular-nums text-af-text-3 md:block">
                      {person.meetingCount > 0
                        ? `${person.meetingCount} meeting${person.meetingCount === 1 ? '' : 's'}${seen ? ` · ${formatRelativePast(seen)}` : ''}`
                        : 'Not met yet'}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Actions for ${person.displayName}`}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-af-text-3 opacity-0 transition-[opacity,background-color] hover:bg-af-active hover:text-af-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenuItem onSelect={() => router.push(`/person?id=${encodeURIComponent(person.id)}`)}>
                          <ArrowUpRight />
                          Open
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setEditing(person)}>
                          <Pencil />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setMerging([person.id])}>
                          <GitMerge />
                          Merge into…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="danger" onSelect={() => setDeleting([person.id])}>
                          <Trash2 />
                          Delete…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {selecting && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center" style={{ paddingLeft: 'var(--af-sidebar-width, 16rem)' }}>
          <div className="pointer-events-auto flex animate-af-rise items-center gap-1.5 rounded-2xl border border-af-border-strong bg-af-elevated/95 p-1.5 pl-4 shadow-2xl backdrop-blur-xl">
            <span className="mr-2 text-[13px] font-medium tabular-nums text-af-text">{selected.size} selected</span>
            <Button variant="secondary" size="sm" onClick={() => setMerging([...selected])} disabled={selected.size < 2}>
              <GitMerge />
              Merge
            </Button>
            <Button variant="danger-ghost" size="sm" onClick={() => setDeleting([...selected])}>
              <Trash2 />
              Delete
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X />
            </Button>
          </div>
        </div>
      )}

      <ContactDialog
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        contact={editing === 'new' ? null : editing}
      />
      <MergeContactsDialog
        open={merging !== null}
        onOpenChange={(next) => !next && setMerging(null)}
        personIds={merging ?? []}
        onMerged={() => setSelected(new Set())}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="danger"
        title={deleting && deleting.length > 1 ? `Delete ${deleting.length} contacts?` : 'Delete this contact?'}
        description="Their lines in meetings go back to generic speaker labels, and their action items lose an owner. Meetings are kept."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleting) return;
          let removed = 0;
          for (const id of deleting) {
            try {
              await deletePerson(id);
              removed += 1;
            } catch (error) {
              toast.error('Could not delete a contact', { description: error instanceof Error ? error.message : String(error) });
            }
          }
          if (removed > 0) {
            announceChange('people');
            announceChange('actions');
            toast.success(removed === 1 ? 'Contact deleted' : `${removed} contacts deleted`);
            setSelected(new Set());
          }
        }}
      />
    </div>
  );
}

export default function ContactsPage() {
  return (
    <Suspense fallback={<div className="h-full bg-af-panel" />}>
      <ContactsInner />
    </Suspense>
  );
}
