'use client';

/**
 * Create or edit a group: name, color, what kind of group it is, a note, and
 * an optional schedule. Mounted once (GroupEditorHost) and opened from
 * anywhere with `openGroupEditor`, so the sidebar, pickers, group pages, and
 * the command bar all share one editor.
 */
import { useEffect, useMemo, useState } from 'react';
import { Briefcase, CalendarClock, FolderKanban, Repeat, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { TimePicker } from '@/components/ui/time-picker';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ColorSwatches, GROUP_KIND_HINT_KEYS, GROUP_KIND_LABEL_KEYS } from '@/components/groups/GroupBits';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { colorForName } from '@/lib/group-colors';
import {
  announceChange,
  createGroup,
  GROUP_KINDS,
  updateGroup,
  type GroupKind,
  type GroupSummary,
} from '@/lib/workspace-api';
import { moveMeetingsToGroup } from '@/lib/meeting-actions';
import { describeSchedule, isValidSchedule, type Cadence, type GroupSchedule } from '@/lib/schedule';
import { useI18n, type MessageKey } from '@/i18n';

export interface GroupEditorRequest {
  /** Edit this group; omit to create one. */
  groupId?: string;
  /** Prefill the name when creating. */
  name?: string;
  /** Meetings to put in the new group once it exists. */
  assignMeetingIds?: string[];
  /** A detected pattern to offer as the schedule. */
  suggestedSchedule?: GroupSchedule | null;
  onSaved?: (group: GroupSummary) => void;
}

const OPEN_EVENT = 'af-open-group-editor';

export function openGroupEditor(request: GroupEditorRequest = {}) {
  window.dispatchEvent(new CustomEvent<GroupEditorRequest>(OPEN_EVENT, { detail: request }));
}

const KIND_ICONS: Record<GroupKind, LucideIcon> = {
  recurring: Repeat,
  customer: Briefcase,
  team: Users,
  project: FolderKanban,
  other: Sparkles,
};

export function kindIcon(kind?: string | null): LucideIcon {
  return KIND_ICONS[(kind as GroupKind) ?? 'other'] ?? Sparkles;
}

const DEFAULT_SCHEDULE: GroupSchedule = { weekdays: [1], time: '09:00', cadence: 'weekly' };

const WEEKDAY_KEYS: readonly MessageKey[] = [
  'people.weekdaySun',
  'people.weekdayMon',
  'people.weekdayTue',
  'people.weekdayWed',
  'people.weekdayThu',
  'people.weekdayFri',
  'people.weekdaySat',
];

export function GroupEditorHost() {
  const { groupById } = useWorkspace();
  const [request, setRequest] = useState<GroupEditorRequest | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => setRequest((event as CustomEvent<GroupEditorRequest>).detail ?? {});
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const existing = request?.groupId ? groupById(request.groupId) : undefined;
  return (
    <GroupEditorDialog
      key={request ? `${request.groupId ?? 'new'}-${request.name ?? ''}` : 'closed'}
      open={request !== null}
      request={request ?? {}}
      existing={existing}
      onClose={() => setRequest(null)}
    />
  );
}

function GroupEditorDialog({
  open,
  request,
  existing,
  onClose,
}: {
  open: boolean;
  request: GroupEditorRequest;
  existing?: GroupSummary;
  onClose: () => void;
}) {
  const editing = !!existing;
  const { t } = useI18n();
  const [name, setName] = useState(existing?.name ?? request.name ?? '');
  const [color, setColor] = useState(existing?.color ?? (request.name ? colorForName(request.name) : 'blue'));
  const [kind, setKind] = useState<GroupKind>((existing?.kind as GroupKind) ?? 'recurring');
  const [description, setDescription] = useState(existing?.description ?? '');
  const initialSchedule = isValidSchedule(existing?.schedule) ? existing!.schedule! : null;
  const [scheduleOn, setScheduleOn] = useState(!!initialSchedule);
  const [schedule, setSchedule] = useState<GroupSchedule>(initialSchedule ?? request.suggestedSchedule ?? DEFAULT_SCHEDULE);
  const [saving, setSaving] = useState(false);

  const suggestion = request.suggestedSchedule && !initialSchedule ? request.suggestedSchedule : null;
  const canSave = name.trim().length > 0 && (!scheduleOn || isValidSchedule(schedule));
  // `t` is a dependency so the schedule preview re-localizes when the interface
  // language changes.
  const preview = useMemo(() => (scheduleOn && isValidSchedule(schedule) ? describeSchedule(schedule) : null), [scheduleOn, schedule, t]);

  const toggleDay = (day: number) => {
    setSchedule((current) => {
      const has = current.weekdays.includes(day);
      const weekdays = has ? current.weekdays.filter((value) => value !== day) : [...current.weekdays, day].sort();
      return { ...current, weekdays };
    });
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const input = {
      name: name.trim(),
      color,
      kind,
      description: description.trim() || null,
      schedule: scheduleOn ? { ...schedule, anchorDate: schedule.anchorDate ?? null } : null,
    };
    try {
      const saved = editing ? await updateGroup(existing!.id, input) : await createGroup(input);
      announceChange('groups');
      if (!editing && request.assignMeetingIds?.length) {
        await moveMeetingsToGroup(request.assignMeetingIds, saved.id, saved.name);
      } else {
        toast.success(editing ? t('people.groupUpdated') : t('people.createdGroup', { name: saved.name }));
      }
      request.onSaved?.(saved);
      onClose();
    } catch (error) {
      toast.error(editing ? t('people.couldNotUpdateGroup') : t('people.couldNotCreateGroup'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('people.editGroup') : t('people.newGroup')}</DialogTitle>
          <DialogDescription>{t('people.groupFormDescription')}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="group-name" className="text-xs font-medium text-af-text-2">
              {t('people.name')}
            </label>
            <Input
              id="group-name"
              value={name}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                if (!editing && !request.name) setColor(colorForName(event.target.value || 'group'));
              }}
              placeholder={t('people.groupNamePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium text-af-text-2">{t('people.color')}</span>
            <ColorSwatches value={color} onChange={setColor} />
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium text-af-text-2">{t('people.whatIsIt')}</span>
            <div role="radiogroup" aria-label={t('people.groupTypeAria')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {GROUP_KINDS.map((option) => {
                const Icon = KIND_ICONS[option.id];
                const selected = option.id === kind;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(option.id)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
                      selected
                        ? 'border-af-accent bg-af-accent/[0.08] shadow-[0_0_0_1px_rgb(var(--af-accent-rgb))]'
                        : 'border-af-border hover:border-af-border-strong hover:bg-af-hover',
                    )}
                  >
                    <Icon className={cn('h-4 w-4', selected ? 'text-af-accent' : 'text-af-text-3')} />
                    <span className="text-[13px] font-medium text-af-text">{t(GROUP_KIND_LABEL_KEYS[option.id])}</span>
                    <span className="text-[11px] leading-snug text-af-text-3">{t(GROUP_KIND_HINT_KEYS[option.id])}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-af-border p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-af-text-3" />
                <div>
                  <p className="text-[13px] font-medium text-af-text">{t('people.schedule')}</p>
                  <p className="text-[11px] text-af-text-3">
                    {preview ?? t('people.scheduleOptionalHint')}
                  </p>
                </div>
              </div>
              <Switch checked={scheduleOn} onCheckedChange={setScheduleOn} aria-label={t('people.setSchedule')} />
            </div>
            {suggestion && !scheduleOn && (
              <button
                type="button"
                onClick={() => {
                  setSchedule(suggestion);
                  setScheduleOn(true);
                }}
                className="mt-3 w-full rounded-lg bg-af-accent/[0.08] px-3 py-2 text-left text-xs text-af-accent transition-colors hover:bg-af-accent/[0.14]"
              >
                {t('people.looksLikeUseThis', { schedule: describeSchedule(suggestion) })}
              </button>
            )}
            {scheduleOn && (
              <div className="mt-3 space-y-3 animate-af-rise">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('people.daysAria')}>
                  {WEEKDAY_KEYS.map((label, day) => {
                    const on = schedule.weekdays.includes(day);
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(day)}
                        className={cn(
                          'h-8 w-11 rounded-lg border text-xs font-medium transition-colors',
                          on ? 'border-af-accent bg-af-accent text-af-on-accent' : 'border-af-border text-af-text-2 hover:bg-af-hover',
                        )}
                      >
                        {t(label)}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <TimePicker
                    value={schedule.time}
                    onChange={(time) => setSchedule((current) => ({ ...current, time }))}
                    aria-label={t('people.startTimeAria')}
                  />
                  <div className="inline-flex rounded-lg border border-af-border bg-af-panel-2 p-[3px]">
                    {(['weekly', 'biweekly'] as Cadence[]).map((cadence) => (
                      <button
                        key={cadence}
                        type="button"
                        onClick={() => setSchedule((current) => ({ ...current, cadence }))}
                        className={cn(
                          'h-7 rounded-md px-3 text-xs font-medium transition-colors',
                          schedule.cadence === cadence ? 'bg-af-raised text-af-text shadow-sm' : 'text-af-text-3 hover:text-af-text',
                        )}
                      >
                        {cadence === 'weekly' ? t('people.everyWeek') : t('people.everyOtherWeek')}
                      </button>
                    ))}
                  </div>
                </div>
                {schedule.weekdays.length === 0 && <p className="text-xs text-af-danger">{t('people.pickAtLeastOneDay')}</p>}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="group-note" className="text-xs font-medium text-af-text-2">
              {t('people.note')} <span className="font-normal text-af-text-4">{t('people.optionalParen')}</span>
            </label>
            <Textarea
              id="group-note"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder={t('people.groupNotePlaceholder')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave} loading={saving}>
              {editing ? t('people.saveChanges') : t('people.createGroup')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
