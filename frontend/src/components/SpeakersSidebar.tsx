"use client";

import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  Edit2,
  GitMerge,
  UserCheck,
  X,
  Check,
  Sparkles,
  ChevronRight,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  speakerDot,
  speakerColor,
  speakerBadgeClass,
  isUserSpeaker,
  displaySpeaker,
} from '@/utils/speakerUtils';
import { MergeSpeakerDialog } from './MergeSpeakerDialog';
import { DetectedSpeaker } from '@/types';

interface SpeakersSidebarProps {
  speakers: DetectedSpeaker[];
  userName: string;
  isOpen: boolean;
  onClose: () => void;
  onRenameSpeaker: (fromSpeaker: string, toSpeaker: string) => Promise<void> | void;
  onMergeSpeaker: (sourceSpeaker: string, targetSpeaker: string) => Promise<void> | void;
  isRecording?: boolean;
}

export function SpeakersSidebar({
  speakers,
  userName,
  isOpen,
  onClose,
  onRenameSpeaker,
  onMergeSpeaker,
  isRecording,
}: SpeakersSidebarProps) {
  // Editing state for inline rename
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Merge modal state
  const [mergeSource, setMergeSource] = useState<string | null>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingSpeaker && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSpeaker]);

  const startRename = (speaker: string) => {
    setEditingSpeaker(speaker);
    setEditValue(isUserSpeaker(speaker) ? (userName || 'You') : speaker);
  };

  const commitRename = async () => {
    if (!editingSpeaker) return;
    const trimmed = editValue.trim();
    const old = editingSpeaker;
    setEditingSpeaker(null);

    if (trimmed && trimmed !== old) {
      await onRenameSpeaker(old, trimmed);
    }
  };

  const cancelRename = () => {
    setEditingSpeaker(null);
  };

  if (!isOpen) return null;

  const totalTurns = speakers.reduce((sum, s) => sum + s.segmentCount, 0);

  return (
    <>
      <aside
        className="w-80 border-l border-[var(--af-border,#e5e7eb)] bg-[var(--af-panel,#ffffff)] flex flex-col h-full shrink-0 shadow-lg transition-all duration-300 z-20"
        aria-label="Detected Speakers Sidebar"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--af-border,#e5e7eb)]">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-blue-500" />
            <span className="font-semibold text-sm text-[var(--af-text,#111827)]">
              Detected Speakers
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-600 dark:text-blue-400">
              {speakers.length}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[var(--af-text-3,#9ca3af)] hover:text-[var(--af-text,#111827)] hover:bg-[var(--af-panel-2,#f3f4f6)] transition-colors"
            title="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Live Call Active Banner */}
        {isRecording && (
          <div className="px-4 py-2 bg-blue-500/5 border-b border-blue-500/15 flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
            <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
            <span>Listening & recognizing voices live</span>
          </div>
        )}

        {/* Speaker List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {speakers.length === 0 ? (
            <div className="text-center py-12 px-2 text-[var(--af-text-3,#6b7280)]">
              <Users size={32} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm font-medium">No speakers detected yet</p>
              <p className="text-xs mt-1 opacity-75">
                Speakers identified by voice diarization will appear here automatically.
              </p>
            </div>
          ) : (
            speakers.map((s) => {
              const isEditing = editingSpeaker === s.name;
              const isYou = s.isUser || isUserSpeaker(s.name);
              const label = displaySpeaker(s.name, userName);
              const percentage = totalTurns > 0 ? Math.round((s.segmentCount / totalTurns) * 100) : 0;

              return (
                <div
                  key={s.id || s.name}
                  className={`group relative rounded-xl border p-3 transition-all duration-150 ${
                    isYou
                      ? 'border-blue-500/30 bg-blue-500/5 hover:border-blue-500/50'
                      : 'border-[var(--af-border,#e5e7eb)] bg-[var(--af-panel-2,#f9fafb)] hover:border-gray-400/50 dark:hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span className={`h-3 w-3 rounded-full shrink-0 ${speakerDot(s.name)}`} />

                      {isEditing ? (
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <Input
                            ref={editInputRef}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitRename();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={commitRename}
                            className="h-7 text-xs px-2 py-0 border-blue-500 focus-visible:ring-1"
                            placeholder="Speaker name"
                          />
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              commitRename();
                            }}
                            className="p-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                            title="Save"
                          >
                            <Check size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => startRename(s.name)}
                            title="Click to rename"
                            className="group/name flex items-center gap-1.5 text-left font-medium text-sm text-[var(--af-text,#111827)] truncate hover:text-blue-600 dark:hover:text-blue-400"
                          >
                            <span className="truncate">{label}</span>
                            <Edit2
                              size={12}
                              className="opacity-0 group-hover/name:opacity-100 text-[var(--af-text-3,#9ca3af)] shrink-0 transition-opacity"
                            />
                          </button>

                          <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--af-text-3,#6b7280)]">
                            <span>
                              {s.segmentCount} {s.segmentCount === 1 ? 'turn' : 'turns'}
                            </span>
                            <span>•</span>
                            <span>{percentage}%</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Action buttons */}
                    {!isEditing && (
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Merge button */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => setMergeSource(s.name)}
                              className="p-1.5 rounded-md text-[var(--af-text-3,#9ca3af)] hover:text-blue-600 hover:bg-blue-500/10 transition-colors"
                              title={`Merge "${s.name}" into another speaker`}
                            >
                              <GitMerge size={15} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">Merge into another speaker</TooltipContent>
                        </Tooltip>

                        {/* This is me button (if not user) */}
                        {!isYou && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => onRenameSpeaker(s.name, 'You')}
                                className="p-1.5 rounded-md text-[var(--af-text-3,#9ca3af)] hover:text-blue-600 hover:bg-blue-500/10 transition-colors"
                                title="Mark as me"
                              >
                                <UserCheck size={15} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">Mark as me</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer info tip */}
        <div className="p-3 border-t border-[var(--af-border,#e5e7eb)] bg-[var(--af-panel-2,#f9fafb)]">
          <div className="flex items-start gap-2 text-[11px] text-[var(--af-text-3,#6b7280)]">
            <Info size={14} className="shrink-0 mt-0.5 text-blue-500" />
            <p className="leading-tight">
              Click any speaker name to rename on the spot. Use the merge icon to combine two speakers who are the same person.
            </p>
          </div>
        </div>
      </aside>

      {/* Merge Speaker Modal */}
      <MergeSpeakerDialog
        open={mergeSource !== null}
        onOpenChange={(open) => !open && setMergeSource(null)}
        sourceSpeaker={mergeSource}
        availableSpeakers={speakers.map((s) => ({
          id: s.id,
          name: s.name,
          isUser: s.isUser,
          segmentCount: s.segmentCount,
        }))}
        onMerge={async (source, target) => {
          await onMergeSpeaker(source, target);
          setMergeSource(null);
        }}
      />
    </>
  );
}
