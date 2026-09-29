import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Mic, Volume2 } from 'lucide-react';
import { LiveAudioVisualizer } from './LiveAudioVisualizer';
import { toDeviceOptionValue, deviceDisplayName } from '@/lib/audio-devices';

export interface AudioDevice {
  name: string;
  device_type: 'Input' | 'Output';
}

export interface SelectedDevices {
  micDevice: string | null;
  systemDevice: string | null;
}

export interface AudioLevelData {
  device_name: string;
  device_type: string;
  rms_level: number;
  peak_level: number;
  is_active: boolean;
}

export interface AudioLevelUpdate {
  timestamp: number;
  levels: AudioLevelData[];
}

export function AudioDeviceCard({
  kind,
  label,
  volumeLabel,
  levelLabel,
  deviceName,
  devices,
  selectedValue,
  open,
  onOpenChange,
  onSelect,
  disabled,
  note,
  unavailable,
  gain,
  onGainLive,
  onGainCommit,
  rmsLevel,
  peakLevel,
  levelTick,
  meterActive = true,
  source,
  hideDevice = false,
}: {
  kind: 'mic' | 'system';
  label: string;
  volumeLabel: string;
  levelLabel: string;
  deviceName: string;
  devices: AudioDevice[];
  selectedValue: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  disabled?: boolean;
  note?: string | null;
  unavailable?: string | null;
  gain?: number;
  onGainLive?: (value: number) => void;
  onGainCommit?: (value: number) => void;
  rmsLevel: number;
  peakLevel: number;
  /** Preview sample clock. Omit it to use the live recording meter. */
  levelTick?: number;
  meterActive?: boolean;
  /** Which audio to record (system audio: everything, or only chosen apps). */
  source?: React.ReactNode;
  /** The device is not used, e.g. while only chosen apps are recorded. */
  hideDevice?: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const closeTimer = useRef<number | null>(null);
  const openTimer = useRef<number | null>(null);
  const [place, setPlace] = useState<'right' | 'below' | 'above'>('right');
  const Icon = kind === 'mic' ? Mic : Volume2;
  const showVolume = typeof gain === 'number' && onGainLive && onGainCommit;

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const cancelOpen = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelOpen();
    cancelClose();
    closeTimer.current = window.setTimeout(() => onOpenChangeRef.current(false), 160);
  };
  const revealMenu = (immediate = false) => {
    if (disabled) return;
    cancelClose();
    if (immediate) {
      cancelOpen();
      onOpenChangeRef.current(true);
      return;
    }
    if (openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      onOpenChangeRef.current(true);
    }, 90);
  };

  useEffect(() => () => {
    cancelClose();
    cancelOpen();
  }, []);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceRight >= 296) setPlace('right');
    else if (spaceBelow >= 200) setPlace('below');
    else setPlace('above');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) onOpenChangeRef.current(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChangeRef.current(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="w-full max-w-[320px] rounded-2xl border border-af-border bg-af-elevated">
      {!hideDevice && (
      <div
        ref={popoverRef}
        className="relative"
        onMouseEnter={() => revealMenu(false)}
        onMouseLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && popoverRef.current?.contains(next)) return;
          scheduleClose();
        }}
      >
      <div className="overflow-hidden rounded-t-[15px]">
      <button
        type="button"
        disabled={disabled}
        onClick={() => revealMenu(true)}
        onFocus={() => revealMenu(true)}
        className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-[var(--af-hover)] disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-[var(--af-text-3)]">{label}</span>
          <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[var(--af-text)]">{deviceName}</span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-[var(--af-text-3)]" />
      </button>
      </div>

      {open && !disabled && (
        <div
          role="dialog"
          aria-label={`${label} devices`}
          onMouseEnter={cancelClose}
          className={`absolute z-50 ${
            place === 'below'
              ? 'left-0 top-full pt-2'
              : place === 'above'
                ? 'bottom-full left-0 pb-2'
                : 'left-full top-0 pl-2'
          }`}
        >
          <div className="w-[280px] overflow-hidden rounded-xl border border-[var(--af-border-strong)] bg-[var(--af-panel)] py-1 shadow-[var(--af-shadow-lg)]">
          <div className="max-h-72 overflow-y-auto" role="radiogroup" aria-label={label}>
            {devices.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-[var(--af-text-3)]">No devices found</p>
            )}
            {devices.map((device) => {
              const value = toDeviceOptionValue(device);
              const selected = selectedValue === value;
              return (
                <DeviceChoice
                  key={value}
                  name={device.name}
                  selected={selected}
                  onSelect={() => onSelect(value)}
                  icon={<Icon size={14} className="shrink-0 text-[var(--af-text-3)]" />}
                />
              );
            })}
          </div>
          </div>
        </div>
      )}
      </div>
      )}

      {source && (
        <div className={`px-3.5 py-3${hideDevice ? '' : ' border-t border-[var(--af-border)]'}`}>
          <div className="mb-2 text-[12px] font-medium text-[var(--af-text-3)]">{hideDevice ? label : 'Record'}</div>
          {source}
        </div>
      )}

      {showVolume && (
        <div className="border-t border-[var(--af-border)] px-3.5 py-3">
          <div className="mb-2 text-[12px] font-medium text-[var(--af-text-3)]">{volumeLabel}</div>
          <SmoothGainSlider
            value={gain}
            label={volumeLabel}
            disabled={disabled}
            onLive={onGainLive}
            onCommit={onGainCommit}
          />
        </div>
      )}

      <div className="border-t border-[var(--af-border)] px-3.5 py-3">
        <div className="mb-2 text-[12px] font-medium text-[var(--af-text-3)]">{levelLabel}</div>
        {levelTick === undefined ? (
          <LiveAudioVisualizer
            active={meterActive}
            source={kind === 'mic' ? 'mic' : 'system'}
            bars={18}
            fill
            className="w-full"
          />
        ) : (
          <LiveAudioVisualizer
            active
            source={kind === 'mic' ? 'mic' : 'system'}
            bars={18}
            fill
            feedRms={rmsLevel}
            feedPeak={peakLevel}
            feedTick={levelTick}
            displayGain={gain ?? 1}
            className="w-full"
          />
        )}
        {unavailable && (
          <p className="mt-2 text-[11px] text-[var(--af-text-3)]">{unavailable} is not connected.</p>
        )}
        {note && <p className="mt-2 text-[11px] text-[var(--af-text-3)]">{note}</p>}
      </div>
    </div>
  );
}

const NAME_GAP = 32;

function textWidth(sample: HTMLElement, text: string) {
  const cs = getComputedStyle(sample);
  const probe = document.createElement('span');
  probe.textContent = text;
  probe.style.cssText = [
    'position:fixed',
    'left:-9999px',
    'top:0',
    'visibility:hidden',
    'white-space:nowrap',
    'width:auto',
    'max-width:none',
    `font:${cs.font}`,
    `letter-spacing:${cs.letterSpacing}`,
  ].join(';');
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

function DeviceChoice({
  name,
  selected,
  onSelect,
  icon,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`mx-1 flex h-11 w-[calc(100%-8px)] cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left ${
        selected ? 'bg-[var(--af-hover)]' : 'hover:bg-[var(--af-hover)]'
      }`}
    >
      {icon}
      <ScrollName text={name} active={hovered} />
      <span
        className={`h-4 w-4 shrink-0 rounded-full border-2 ${
          selected ? 'border-[var(--af-accent)] bg-[var(--af-accent)]' : 'border-[var(--af-text-3)] bg-transparent'
        }`}
      />
    </button>
  );
}

function ScrollName({ text, active }: { text: string; active: boolean }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const sample = textRef.current;
    if (!outer || !sample) return;
    const measure = () => {
      const available = outer.clientWidth;
      if (available <= 0) return;
      const width = textWidth(sample, text);
      setDistance(width - available > 1 ? width + NAME_GAP : 0);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrolling = active && distance > 0 && !reduceMotion;
  const duration = Math.max(1.5, distance / 52);

  // One structure for both states, so the name never moves when scrolling
  // starts: a block-level flex row (an inline box would sit on the text
  // baseline and drop a few pixels) whose first copy stays put and only stops
  // truncating, with a second copy after the gap while it scrolls.
  return (
    <span ref={outerRef} className="block h-5 min-w-0 flex-1 overflow-hidden">
      <span
        className={`flex h-5 items-center ${scrolling ? 'af-name-scroll w-max' : 'w-full'}`}
        style={
          scrolling
            ? {
                ['--af-shift' as string]: `${distance}px`,
                animationDuration: `${duration}s`,
                animationDelay: '40ms',
              }
            : undefined
        }
      >
        <span
          ref={textRef}
          className={`whitespace-nowrap text-[13px] leading-5 text-[var(--af-text)] ${scrolling ? 'shrink-0' : 'min-w-0 truncate'}`}
        >
          {text}
        </span>
        {scrolling && (
          <span aria-hidden className="shrink-0 whitespace-nowrap text-[13px] leading-5 text-[var(--af-text)]" style={{ paddingLeft: NAME_GAP }}>
            {text}
          </span>
        )}
      </span>
    </span>
  );
}

function SmoothGainSlider({
  value,
  label,
  disabled,
  onLive,
  onCommit,
}: {
  value: number;
  label: string;
  disabled?: boolean;
  onLive: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(value);
  const dragging = useRef(false);
  const over = useRef(false);
  const [shown, setShown] = useState(value);
  const [tip, setTip] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    const tick = () => {
      const delta = value - shownRef.current;
      if (Math.abs(delta) < 0.003) {
        shownRef.current = value;
        setShown(value);
        return;
      }
      shownRef.current += delta * 0.35;
      setShown(shownRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  const pct = ((shown - 0.5) / 2.5) * 100;

  const valueFromX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round((0.5 + ratio * 2.5) * 10) / 10;
  };

  const nudge = (direction: number) => {
    const next = Math.min(3, Math.max(0.5, Math.round((value + direction * 0.1) * 10) / 10));
    onLive(next);
    onCommit(next);
  };

  const showTip = (nextDragging: boolean) => setTip(over.current || nextDragging);

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0.5}
      aria-valuemax={3}
      aria-valuenow={value}
      aria-valuetext={`${value.toFixed(1)}×`}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          nudge(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault();
          nudge(-1);
        }
      }}
      onPointerEnter={() => {
        over.current = true;
        showTip(dragging.current);
      }}
      onPointerLeave={() => {
        over.current = false;
        showTip(dragging.current);
      }}
      onFocus={() => setTip(true)}
      onBlur={() => { if (!dragging.current) setTip(false); }}
      onPointerDown={(event) => {
        if (disabled) return;
        dragging.current = true;
        setTip(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        onLive(valueFromX(event.clientX));
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        onLive(valueFromX(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        const next = valueFromX(event.clientX);
        onLive(next);
        onCommit(next);
        showTip(false);
      }}
      className={`relative flex h-5 items-center outline-none ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer'}`}
    >
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--af-border)]" />
      <span className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--af-accent)]" style={{ width: `${pct}%` }} />
      <span
        className="pointer-events-none absolute top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: `${pct}%`, backgroundColor: '#ffffff', boxShadow: '0 0 0 1px rgba(0,0,0,0.28)' }}
      >
        {tip && (
          <span className="absolute bottom-full left-1/2 z-20 mb-2.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground">
            {label} {value.toFixed(1)}×
          </span>
        )}
      </span>
    </div>
  );
}
