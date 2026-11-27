'use client';

/**
 * Group visuals used everywhere a group appears: the chip (the group's name on
 * a soft tint of its color), the searchable picker (with "Create …"), the color
 * swatches, and the small color dot that labels groups inside pickers and menus.
 */
import * as React from 'react';
import { Check, ChevronDown, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GROUP_COLORS, groupColorVar, type GroupColor } from '@/lib/group-colors';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { announceChange, createGroup, type GroupKind, type GroupSummary } from '@/lib/workspace-api';
import { colorForName } from '@/lib/group-colors';
import { toast } from 'sonner';
import { tNow, useI18n, type MessageKey } from '@/i18n';

/** Group kind labels and hints; the stored kind id never changes. */
export const GROUP_KIND_LABEL_KEYS: Record<GroupKind, MessageKey> = {
  recurring: 'people.kindRecurring',
  customer: 'people.kindCustomer',
  team: 'people.kindTeam',
  project: 'people.kindProject',
  other: 'people.kindOther',
};

export const GROUP_KIND_HINT_KEYS: Record<GroupKind, MessageKey> = {
  recurring: 'people.kindRecurringHint',
  customer: 'people.kindCustomerHint',
  team: 'people.kindTeamHint',
  project: 'people.kindProjectHint',
  other: 'people.kindOtherHint',
};

/** The label key for a stored group kind; nothing for 'other' or unknown kinds. */
export function kindLabelKey(kind?: string | null): MessageKey | null {
  if (!kind || kind === 'other') return null;
  return (GROUP_KIND_LABEL_KEYS as Record<string, MessageKey>)[kind] ?? null;
}

/** Display names for the stored color keys. */
export const GROUP_COLOR_LABEL_KEYS: Record<GroupColor, MessageKey> = {
  blue: 'people.colorBlue',
  sky: 'people.colorSky',
  teal: 'people.colorTeal',
  green: 'people.colorGreen',
  amber: 'people.colorAmber',
  orange: 'people.colorOrange',
  red: 'people.colorRed',
  pink: 'people.colorPink',
  violet: 'people.colorViolet',
  slate: 'people.colorSlate',
};

export function GroupDot({ color, className }: { color?: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('af-tint-dot inline-block h-2 w-2 shrink-0 rounded-full', className)}
      style={{ '--chip': groupColorVar(color) } as React.CSSProperties}
    />
  );
}

/** A group's name on a soft tint of its color. Pass `onClick` to make it a button. */
export function GroupChip({
  group,
  size = 'sm',
  onClick,
  className,
  trailing,
}: {
  group: Pick<GroupSummary, 'name' | 'color'>;
  size?: 'xs' | 'sm' | 'md';
  onClick?: () => void;
  className?: string;
  trailing?: React.ReactNode;
}) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'af-tint inline-flex max-w-full items-center gap-1 rounded-md font-medium leading-none',
        size === 'xs' && 'h-5 px-1.5 text-[11px]',
        size === 'sm' && 'h-6 px-2 text-xs',
        size === 'md' && 'h-7 px-2.5 text-[13px]',
        onClick && 'transition-[filter,transform] hover:brightness-110 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
        className,
      )}
      style={{ '--chip': groupColorVar(group.color) } as React.CSSProperties}
    >
      <span className="truncate">{group.name}</span>
      {trailing}
    </Tag>
  );
}

export function groupOptions(groups: GroupSummary[]): ComboboxOption[] {
  return groups.map((group) => ({
    value: group.id,
    label: group.name,
    color: group.color ?? 'blue',
    description: group.meetingCount
      ? tNow(group.meetingCount === 1 ? 'people.meetingCountOne' : 'people.meetingCountMany', { count: group.meetingCount })
      : undefined,
  }));
}

/** Creates a group from a picker's "Create …" row and returns it as an option. */
export async function createGroupFromPicker(name: string): Promise<ComboboxOption | void> {
  try {
    const created = await createGroup({ name, color: colorForName(name), kind: 'other' });
    announceChange('groups');
    return { value: created.id, label: created.name, color: created.color };
  } catch (error) {
    toast.error(tNow('people.couldNotCreateGroup'), { description: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Searchable group picker. The default trigger is a chip showing the current
 * group (or "No group"); pass `trigger` for a custom one.
 */
export function GroupPicker({
  value,
  onChange,
  trigger,
  align = 'start',
  side = 'bottom',
  disabled,
  placeholder,
  triggerClassName,
}: {
  value: string | null;
  /** Receives the name too, since a group created from the picker may not be listed yet. */
  onChange: (groupId: string | null, name?: string) => void;
  trigger?: React.ReactElement;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
}) {
  const { t } = useI18n();
  const { groups, groupById } = useWorkspace();
  const current = groupById(value);
  return (
    <Combobox
      value={value}
      onChange={(next, option) => onChange(next, option?.label)}
      options={groupOptions(groups)}
      clearLabel={t('people.noGroup')}
      searchPlaceholder={t('people.findOrCreateGroup')}
      emptyText={t('people.noGroupsYet')}
      onCreate={createGroupFromPicker}
      createLabel={(query) => t('people.createGroupNamed', { name: query })}
      align={align}
      side={side}
      disabled={disabled}
      aria-label={t('people.groupAria')}
      trigger={
        trigger ?? (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-md px-2 text-xs font-medium transition-[background-color,border-color,color,filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60 disabled:opacity-50',
              current ? 'af-tint hover:brightness-110' : 'border border-dashed border-af-border-strong text-af-text-3 hover:border-af-text-4 hover:text-af-text-2',
              triggerClassName,
            )}
            style={current ? ({ '--chip': groupColorVar(current.color) } as React.CSSProperties) : undefined}
          >
            {!current && <Layers className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{current?.name ?? placeholder ?? t('people.noGroup')}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
          </button>
        )
      }
    />
  );
}

/** Color swatches for choosing a group's color. */
export function ColorSwatches({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (color: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t('people.groupColorAria')} className={cn('flex flex-wrap gap-2', className)}>
      {GROUP_COLORS.map((color) => {
        const selected = color.key === value;
        return (
          <button
            key={color.key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(GROUP_COLOR_LABEL_KEYS[color.key])}
            onClick={() => onChange(color.key)}
            className={cn(
              'af-tint-dot flex h-7 w-7 items-center justify-center rounded-full text-white transition-transform duration-150 ease-af hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-af-elevated',
              selected && 'ring-2 ring-af-text/70 ring-offset-2 ring-offset-af-elevated',
            )}
            style={{ '--chip': groupColorVar(color.key) } as React.CSSProperties}
          >
            {selected && <Check className="h-3.5 w-3.5 drop-shadow" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}
