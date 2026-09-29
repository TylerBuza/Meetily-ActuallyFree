"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGE_OPTIONS } from "@/lib/summary-languages";
import { useRecentLanguages } from "@/hooks/useRecentLanguages";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { floatingSurface } from "@/components/ui/popover";

interface LanguagePickerPopoverProps {
  value: string | null;
  onChange: (code: string | null) => void;
  onClose: () => void;
  mode?: "meeting" | "settings";
  autoSubtitle?: string;
}

export function LanguagePickerPopover({
  value,
  onChange,
  onClose,
  mode = "meeting",
  autoSubtitle,
}: LanguagePickerPopoverProps) {
  const { recents } = useRecentLanguages();
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filter = query.trim().toLowerCase();

  const recentCodes = useMemo(() => new Set(recents), [recents]);

  const filteredAll = useMemo(() => {
    const options = mode === "meeting"
      ? LANGUAGE_OPTIONS.filter((l) => !recentCodes.has(l.code))
      : LANGUAGE_OPTIONS;
    if (!filter) return options;
    return options.filter(
      (l) =>
        l.code.toLowerCase().includes(filter) ||
        l.label.toLowerCase().includes(filter),
    );
  }, [filter, mode, recentCodes]);

  const recentsResolved = useMemo(
    () =>
      recents
        .map((code) => LANGUAGE_OPTIONS.find((l) => l.code === code))
        .filter((l): l is (typeof LANGUAGE_OPTIONS)[number] => Boolean(l))
        .filter(
          (l) =>
            !filter ||
            l.code.toLowerCase().includes(filter) ||
            l.label.toLowerCase().includes(filter),
        ),
    [recents, filter],
  );

  const showAuto = mode === "meeting" && (!filter || "auto".includes(filter));
  const showRecents = mode === "meeting" && recentsResolved.length > 0;
  const hasNoResults =
    filteredAll.length === 0 && recentsResolved.length === 0 && !showAuto;

  const row = (selected: boolean) =>
    cn(
      "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-af-hover",
      selected ? "font-medium text-af-text" : "text-af-text-2 hover:text-af-text",
    );
  const sectionLabel = "px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4";
  const tick = <Check className="h-4 w-4 shrink-0 text-af-accent" aria-hidden="true" />;

  return (
    <div
      ref={containerRef}
      className={cn("w-72 overflow-hidden", floatingSurface)}
      role="dialog"
      aria-label="Pick summary language"
    >
      <div className="flex h-10 items-center gap-2 border-b border-af-border px-3">
        <Search className="h-4 w-4 shrink-0 text-af-text-4" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search languages"
          aria-label="Search languages"
          className="h-full min-w-0 flex-1 border-none bg-transparent text-[13px] text-af-text outline-none placeholder:text-af-text-4"
        />
      </div>

      <div className="max-h-80 overflow-y-auto p-1">
        {showRecents && (
          <>
            <div className={sectionLabel}>Recently used</div>
            {recentsResolved.map((opt) => (
              <button
                key={`recent-${opt.code}`}
                type="button"
                aria-pressed={value === opt.code}
                onClick={() => onChange(opt.code)}
                className={row(value === opt.code)}
              >
                <span className="truncate">
                  {opt.label}
                  <span className="ml-1.5 text-[11px] font-normal text-af-text-4">{opt.code}</span>
                </span>
                {value === opt.code && tick}
              </button>
            ))}
            <div className="mx-1 my-1 h-px bg-af-border" />
          </>
        )}

        {showAuto && (
          <button
            type="button"
            aria-pressed={value === null}
            onClick={() => onChange(null)}
            className={row(value === null)}
          >
            <span className="flex min-w-0 flex-col">
              <span>Auto</span>
              {autoSubtitle && <span className="text-[11px] font-normal text-af-text-3">{autoSubtitle}</span>}
            </span>
            {value === null && tick}
          </button>
        )}

        {filteredAll.length > 0 && (
          <div className={sectionLabel}>{mode === "meeting" ? "Other languages" : "All languages"}</div>
        )}

        {filteredAll.map((opt) => (
          <button
            key={`all-${opt.code}`}
            type="button"
            aria-pressed={value === opt.code}
            onClick={() => onChange(opt.code)}
            className={row(value === opt.code)}
          >
            <span className="truncate">
              {opt.label}
              <span className="ml-1.5 text-[11px] font-normal text-af-text-4">{opt.code}</span>
            </span>
            {value === opt.code && tick}
          </button>
        ))}

        {hasNoResults && <div className="px-2.5 py-2 text-[13px] text-af-text-4">No matches</div>}
      </div>
    </div>
  );
}
