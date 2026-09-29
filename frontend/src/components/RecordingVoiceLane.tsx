'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronDown, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LiveAudioVisualizer } from '@/components/LiveAudioVisualizer';
import { AudioDeviceCard } from '@/components/DeviceSelection';
import {
  deviceDisplayName,
  toDeviceOptionValue,
  type AudioDeviceOption,
} from '@/lib/audio-devices';

let levelMonitorQueue: Promise<void> = Promise.resolve();

function runLevelMonitor(task: () => Promise<void>) {
  levelMonitorQueue = levelMonitorQueue.then(task, task);
}

interface LevelEvent {
  levels?: Array<{
    device_name?: string;
    device_type?: string;
    rms_level?: number;
    peak_level?: number;
  }>;
}

export function RecordingVoiceLane({
  kind,
  open,
  onOpenChange,
  savedValue,
  options,
  onSelect,
  disabled,
  gain,
  onGainLive,
  onGainCommit,
  macDefaultOutput = false,
  live = false,
  muted = false,
  meterActive = false,
  onMute,
  source,
  hideDevice = false,
}: {
  kind: 'mic' | 'output';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stored preference, or null for the system default. */
  savedValue: string | null;
  options: AudioDeviceOption[];
  onSelect: (value: string) => void;
  disabled?: boolean;
  gain: number;
  onGainLive: (value: number) => void;
  onGainCommit: (value: number) => void;
  macDefaultOutput?: boolean;
  /** Recording is underway. The same button mutes, and the chevron becomes a meter. */
  live?: boolean;
  muted?: boolean;
  meterActive?: boolean;
  onMute?: () => void;
  /** Which audio to record, shown in the panel (system audio). */
  source?: React.ReactNode;
  hideDevice?: boolean;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [meter, setMeter] = useState({ rms: 0, peak: 0, tick: 0 });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const Icon = kind === 'mic' ? Mic : Volume2;
  const chosen = options.find((device) => toDeviceOptionValue(device) === savedValue);
  const summary = macDefaultOutput
    ? 'System default'
    : chosen?.name || (savedValue ? deviceDisplayName(savedValue) : kind === 'mic' ? 'Default microphone' : 'Default output');

  useEffect(() => {
    if (!open) setListOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || live) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const opts = optionsRef.current;
    const selected = opts.find((device) => toDeviceOptionValue(device) === savedValue);
    const wanted = selected?.name ?? (savedValue ? deviceDisplayName(savedValue) : null);
    const wantedType = kind === 'mic' ? 'input' : 'output';

    runLevelMonitor(async () => {
      await invoke('start_audio_level_monitoring', { deviceNames: wanted ? [wanted] : [] });
    });

    void listen<LevelEvent>('audio-levels', (event) => {
      if (cancelled) return;
      const levels = event.payload?.levels ?? [];
      const sameType = (level: { device_type?: string }) => {
        const type = (level.device_type || '').toLowerCase();
        return type === wantedType || type.includes(wantedType);
      };
      const named = wanted
        ? levels.find((level) => {
          const name = level.device_name || '';
          return name.length > 0 && (name === wanted || name.includes(wanted) || wanted.includes(name));
        })
        : undefined;
      const match = named ?? levels.find(sameType) ?? levels.reduce<(typeof levels)[number] | undefined>((best, level) => {
        const score = Math.max(level.rms_level ?? 0, level.peak_level ?? 0);
        const bestScore = Math.max(best?.rms_level ?? 0, best?.peak_level ?? 0);
        return score >= bestScore ? level : best;
      }, undefined);
      setMeter({
        rms: match?.rms_level ?? 0,
        peak: match?.peak_level ?? 0,
        tick: Date.now(),
      });
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.error('Failed to listen for device levels:', error));

    return () => {
      cancelled = true;
      unlisten?.();
      setMeter({ rms: 0, peak: 0, tick: 0 });
      runLevelMonitor(async () => {
        await invoke('stop_audio_level_monitoring').catch(() => undefined);
      });
    };
  }, [open, live, savedValue, kind]);

  // macOS has no output to pick, but the panel still opens for `source`.
  const canOpen = !macDefaultOutput || !!source;
  const settingsLabel = kind === 'mic' ? 'Input settings' : 'Output settings';
  const muteLabel = kind === 'mic'
    ? (muted ? 'Unmute microphone' : 'Mute microphone')
    : (muted ? 'Unmute output' : 'Mute output');
  const OffIcon = kind === 'mic' ? MicOff : VolumeX;

  const ease = 'duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none';

  return (
    <div
      className={`flex h-9 items-stretch overflow-hidden rounded-full bg-af-panel-2 ring-1 ring-inset ring-af-border ${live ? 'min-w-0 flex-1' : 'shrink-0'}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={muted}
            aria-label={muteLabel}
            onClick={() => onMute?.()}
            className={`flex items-center justify-center transition-[padding,background-color,color] ${ease} ${
              live ? 'min-w-0 flex-1 px-2.5' : 'w-8 shrink-0'
            } ${
              muted
                ? 'bg-af-warning/15 text-af-warning hover:bg-af-warning/25'
                : 'text-af-text-2 hover:bg-af-hover hover:text-af-text'
            } disabled:opacity-50`}
          >
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              <Icon
                size={15}
                strokeWidth={1.75}
                className={`absolute transition-opacity duration-300 ${muted ? 'opacity-0' : 'opacity-100'}`}
              />
              <OffIcon
                size={15}
                strokeWidth={1.75}
                className={`absolute transition-opacity duration-300 ${muted ? 'opacity-100' : 'opacity-0'}`}
              />
            </span>
            <span className={`grid h-4 items-center overflow-hidden transition-[width,flex-grow,opacity,margin] ${ease} ${
              live ? 'ml-2 w-full min-w-0 max-w-24 flex-1 opacity-100' : 'ml-0 w-0 opacity-0'
            }`}>
              <span className="min-w-0 overflow-hidden">
                <LiveAudioVisualizer active={meterActive} source={kind === 'mic' ? 'mic' : 'system'} bars={18} fill className="w-full" />
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          <p>{muteLabel}</p>
        </TooltipContent>
      </Tooltip>

      <Popover open={open} onOpenChange={(next) => { if (!disabled && canOpen) onOpenChange(next); }}>
        <Tooltip open={open ? false : undefined}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled || !canOpen}
                aria-expanded={open}
                aria-label={settingsLabel}
                className={`flex w-[22px] shrink-0 items-center justify-center transition-colors duration-150 ${
                  open ? 'bg-af-active text-af-text' : 'text-af-text-3 hover:bg-af-hover hover:text-af-text'
                } disabled:opacity-40`}
              >
                <ChevronDown
                  size={12}
                  strokeWidth={2.25}
                  className={`transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${open ? 'rotate-180' : ''}`}
                />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            <p>{settingsLabel}</p>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={10}
          className="w-[320px] overflow-visible rounded-2xl border-0 bg-transparent p-0 text-af-text shadow-lg"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <AudioDeviceCard
            kind={kind === 'mic' ? 'mic' : 'system'}
            label={kind === 'mic' ? 'Microphone' : 'System audio'}
            volumeLabel={kind === 'mic' ? 'Mic volume' : 'System volume'}
            levelLabel={kind === 'mic' ? 'Input level' : 'System level'}
            deviceName={summary}
            devices={macDefaultOutput ? [] : options}
            selectedValue={macDefaultOutput ? null : savedValue}
            open={listOpen}
            onOpenChange={(next) => {
              if (macDefaultOutput) return;
              setListOpen(next);
            }}
            onSelect={(value) => {
              onSelect(value);
              setListOpen(false);
            }}
            disabled={macDefaultOutput}
            note={macDefaultOutput && !hideDevice ? 'macOS records the current system output.' : null}
            unavailable={
              !macDefaultOutput && savedValue && options.length > 0 && !options.some((device) => toDeviceOptionValue(device) === savedValue)
                ? deviceDisplayName(savedValue)
                : null
            }
            gain={gain}
            onGainLive={onGainLive}
            onGainCommit={onGainCommit}
            rmsLevel={meter.rms}
            peakLevel={meter.peak}
            levelTick={live ? undefined : meter.tick}
            meterActive={meterActive}
            source={source}
            hideDevice={hideDevice}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

