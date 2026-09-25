"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GitMerge, UserRound, ArrowRight, Check } from 'lucide-react';
import { speakerDot, speakerColor, isUserSpeaker, displaySpeaker } from '@/utils/speakerUtils';

export interface MergeSpeakerOption {
  id: string;
  name: string;
  isUser?: boolean;
  segmentCount?: number;
}

interface MergeSpeakerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceSpeaker: string | null;
  availableSpeakers: MergeSpeakerOption[];
  onMerge: (sourceSpeaker: string, targetSpeaker: string) => Promise<void> | void;
}

export function MergeSpeakerDialog({
  open,
  onOpenChange,
  sourceSpeaker,
  availableSpeakers,
  onMerge,
}: MergeSpeakerDialogProps) {
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [isMerging, setIsMerging] = useState(false);
  const [userName, setUserName] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUserName(localStorage.getItem('meetily_user_name')?.trim() || '');
    }
  }, []);

  // Filter out the source speaker itself from candidates
  const candidates = availableSpeakers.filter(
    (s) => s.name.trim().toLowerCase() !== sourceSpeaker?.trim().toLowerCase()
  );

  // Default selection to first available candidate
  useEffect(() => {
    if (open && candidates.length > 0) {
      setSelectedTarget(candidates[0].name);
    }
  }, [open, sourceSpeaker]);

  const handleConfirmMerge = async () => {
    if (!sourceSpeaker || !selectedTarget || isMerging) return;
    setIsMerging(true);
    try {
      await onMerge(sourceSpeaker, selectedTarget);
      onOpenChange(false);
    } catch (e) {
      console.error('Failed to merge speakers:', e);
    } finally {
      setIsMerging(false);
    }
  };

  if (!sourceSpeaker) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-[var(--af-panel,#ffffff)] border-[var(--af-border,#e5e7eb)] text-[var(--af-text,#111827)] shadow-xl">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <GitMerge size={20} />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">Merge Speaker</DialogTitle>
              <DialogDescription className="text-xs text-[var(--af-text-3,#6b7280)] mt-0.5">
                Reassign all turns from this voice to another person.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Source Speaker Banner */}
          <div className="flex items-center justify-between rounded-lg border border-[var(--af-border,#e5e7eb)] bg-[var(--af-panel-2,#f9fafb)] p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={`h-3 w-3 rounded-full shrink-0 ${speakerDot(sourceSpeaker)}`} />
              <div className="truncate">
                <span className="text-xs text-[var(--af-text-3,#6b7280)] block">Merging voice:</span>
                <span className={`text-sm font-semibold truncate ${speakerColor(sourceSpeaker)}`}>
                  {displaySpeaker(sourceSpeaker, userName)}
                </span>
              </div>
            </div>
            <ArrowRight size={18} className="text-[var(--af-text-3,#9ca3af)] shrink-0 mx-2" />
            <div className="text-right min-w-0">
              <span className="text-xs text-[var(--af-text-3,#6b7280)] block">Target:</span>
              <span className="text-sm font-semibold text-blue-600 dark:text-blue-400 truncate block">
                {selectedTarget ? displaySpeaker(selectedTarget, userName) : 'Select below'}
              </span>
            </div>
          </div>

          {/* Target Speaker Selection */}
          <div>
            <label className="text-xs font-medium text-[var(--af-text-2,#4b5563)] block mb-2">
              Select destination speaker:
            </label>

            {candidates.length === 0 ? (
              <p className="text-xs text-[var(--af-text-3,#6b7280)] italic py-2">
                No other speakers detected yet to merge into.
              </p>
            ) : (
              <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                {candidates.map((c) => {
                  const isSelected = selectedTarget === c.name;
                  const label = displaySpeaker(c.name, userName);
                  const isYou = isUserSpeaker(c.name);

                  return (
                    <button
                      key={c.id || c.name}
                      type="button"
                      onClick={() => setSelectedTarget(c.name)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left text-sm transition-all ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300 font-medium'
                          : 'border-[var(--af-border,#e5e7eb)] hover:bg-[var(--af-panel-2,#f3f4f6)] text-[var(--af-text,#111827)]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${speakerDot(c.name)}`} />
                        <span className="truncate">{label}</span>
                        {isYou && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/20 text-blue-600 dark:text-blue-300">
                            You
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {c.segmentCount !== undefined && (
                          <span className="text-xs text-[var(--af-text-3,#9ca3af)]">
                            {c.segmentCount} {c.segmentCount === 1 ? 'turn' : 'turns'}
                          </span>
                        )}
                        {isSelected && <Check size={16} className="text-blue-600 dark:text-blue-400" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <p className="text-[11px] text-[var(--af-text-3,#6b7280)] leading-relaxed">
            💡 All segments currently attributed to <strong>{sourceSpeaker}</strong> will be reassigned to{' '}
            <strong>{selectedTarget ? displaySpeaker(selectedTarget, userName) : 'the target'}</strong>.
            During a live call, upcoming turns detected for this voice will also automatically map to the target.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 mt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isMerging}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmMerge}
            disabled={!selectedTarget || candidates.length === 0 || isMerging}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {isMerging ? 'Merging...' : 'Merge Speakers'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
