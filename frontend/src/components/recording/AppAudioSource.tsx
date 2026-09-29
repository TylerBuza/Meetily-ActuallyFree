'use client';

/**
 * Choose the computer audio a recording captures: everything the computer
 * plays, or only chosen apps, e.g. just the call without music or
 * notification sounds. Shown in Settings > Recording and in the record card's
 * system audio panel; both edit the same saved choice.
 */
import { useMemo, useState } from 'react';
import { AppWindow, FolderOpen, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePlatform } from '@/hooks/usePlatform';
import { useAppAudio, type AppAudioChoice } from '@/hooks/useAppAudio';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Spinner } from '@/components/ui/spinner';
import type { PerAppTarget } from '@/components/RecordingSettings';

/** Per-app capture exists on Windows and macOS. */
export function useAppAudioSupported(): boolean {
  const platform = usePlatform();
  return platform === 'windows' || platform === 'macos';
}

const STATUS_DOT: Record<ReturnType<AppAudioChoice['statusOf']>, string> = {
  playing: 'bg-af-success',
  open: 'bg-af-text-4',
  closed: 'border border-af-text-4 bg-transparent',
  unknown: 'bg-af-text-4/50',
};

const STATUS_LABEL: Record<ReturnType<AppAudioChoice['statusOf']>, string> = {
  playing: 'playing sound',
  open: 'open',
  closed: 'not open',
  unknown: '',
};

function ModeSwitch({ choice, disabled }: { choice: AppAudioChoice; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Computer audio to record" className="inline-flex w-full rounded-lg border border-af-border bg-af-panel-2 p-[3px]">
      {([false, true] as const).map((onlyApps) => {
        const selected = choice.onlyApps === onlyApps;
        return (
          <button
            key={String(onlyApps)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => !selected && choice.setOnlyApps(onlyApps)}
            className={cn(
              'h-7 flex-1 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed',
              selected ? 'bg-af-raised text-af-text shadow-sm' : 'text-af-text-3 hover:text-af-text disabled:hover:text-af-text-3',
            )}
          >
            {onlyApps ? 'Only chosen apps' : 'All computer audio'}
          </button>
        );
      })}
    </div>
  );
}

function AddAppButton({ choice, disabled }: { choice: AppAudioChoice; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const available = useMemo(
    () =>
      choice.running.filter(
        (app) => !choice.targets.some((target) => target.executable.toLowerCase() === app.executable.toLowerCase()),
      ),
    [choice.running, choice.targets],
  );
  const playing = available.filter((app) => app.has_audio);
  const others = available.filter((app) => !app.has_audio);

  const row = (app: (typeof available)[number]) => (
    <CommandItem
      key={`${app.executable}-${app.pid ?? ''}`}
      value={`${app.name} ${app.executable}`}
      onSelect={() => {
        choice.addApp(app);
        setOpen(false);
      }}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', app.has_audio ? 'bg-af-success' : 'bg-af-text-4/60')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-af-text">{app.name}</span>
        <span className="block truncate text-[11px] text-af-text-4">{app.executable}</span>
      </span>
    </CommandItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void choice.scan();
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-af-border-strong px-2.5 text-xs font-medium text-af-text-2 transition-colors hover:border-af-accent/50 hover:text-af-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add app
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden p-0">
        <Command>
          <CommandInput placeholder="Search open apps" />
          <CommandList className="max-h-72 p-1">
            {choice.scanning && available.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-af-text-3">
                <Spinner size={12} /> Looking for open apps…
              </div>
            ) : (
              <CommandEmpty>No matching open apps.</CommandEmpty>
            )}
            {playing.length > 0 && <CommandGroup heading="Playing sound now">{playing.map(row)}</CommandGroup>}
            {others.length > 0 && <CommandGroup heading="Open apps">{others.map(row)}</CommandGroup>}
          </CommandList>
          <div className="border-t border-af-border p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void choice.browse();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-af-text-2 transition-colors hover:bg-af-hover hover:text-af-text"
            >
              <FolderOpen className="h-4 w-4 text-af-text-3" />
              Choose an app that is not open…
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AppChip({ target, choice, disabled }: { target: PerAppTarget; choice: AppAudioChoice; disabled?: boolean }) {
  const status = choice.statusOf(target);
  return (
    <li className="flex h-7 max-w-full items-center gap-1.5 rounded-full border border-af-border bg-af-panel pl-2.5 pr-1 text-xs text-af-text">
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])}
        role="img"
        aria-label={STATUS_LABEL[status] || undefined}
      />
      <span className="min-w-0 truncate">{target.name}</span>
      <button
        type="button"
        onClick={() => choice.removeApp(target.executable)}
        disabled={disabled}
        aria-label={`Stop recording ${target.name}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-text disabled:pointer-events-none"
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

/**
 * `live`: a recording is running. The choice is read when a recording
 * starts, so it is shown but not editable until the next one.
 */
export function AppAudioSource({
  choice,
  variant = 'full',
  live = false,
}: {
  /** From useAppAudio, so a parent can also read the choice. */
  choice: AppAudioChoice;
  variant?: 'full' | 'compact';
  live?: boolean;
}) {
  const platform = usePlatform();
  const compact = variant === 'compact';

  if (!choice.loaded) return <div className="af-skeleton h-8 rounded-lg" />;

  const hint = live
    ? 'Applies from your next recording.'
    : choice.onlyApps && choice.targets.length === 0
      ? 'Until you add an app, all computer audio is recorded.'
      : choice.onlyApps && platform === 'macos'
        ? 'On macOS the first chosen app that is open is recorded.'
        : choice.onlyApps
          ? "Only these apps are recorded. If none is open when you start, the recording can't start."
          : null;

  return (
    <div className={cn('space-y-2.5', compact && 'space-y-2')}>
      <ModeSwitch choice={choice} disabled={live} />
      {choice.onlyApps && (
        <ul className="flex flex-wrap items-center gap-1.5">
          {choice.targets.map((target) => (
            <AppChip key={target.executable} target={target} choice={choice} disabled={live} />
          ))}
          <li>
            <AddAppButton choice={choice} disabled={live} />
          </li>
        </ul>
      )}
      {hint && <p className={cn('leading-relaxed text-af-text-3', compact ? 'text-[11px]' : 'text-xs')}>{hint}</p>}
      {choice.onlyApps && !compact && choice.targets.length > 0 && (
        <p className="flex items-center gap-3 text-[11px] text-af-text-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-af-success" /> Playing sound
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-af-text-4" /> Open
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full border border-af-text-4" /> Not open
          </span>
        </p>
      )}
    </div>
  );
}

/** Settings > Recording card. */
export function AppAudioCard() {
  const supported = useAppAudioSupported();
  const choice = useAppAudio();
  if (!supported) return null;
  return (
    <div className="min-w-0 rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
      <div className="mb-3 flex items-start gap-3">
        <AppWindow className="mt-0.5 h-4 w-4 shrink-0 text-af-accent" />
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-af-text">Computer audio</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
            Record everything your computer plays, or only the apps you choose, such as just the call without music or
            notification sounds. You can also change this from the record card.
          </p>
        </div>
      </div>
      <AppAudioSource choice={choice} />
    </div>
  );
}
