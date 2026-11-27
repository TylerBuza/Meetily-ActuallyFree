'use client';

/**
 * TranscriptRecovery Component
 *
 * Modal dialog for recovering interrupted meetings from IndexedDB.
 * Displays recoverable meetings, allows preview, and enables recovery or deletion.
 */

import React, { useState, useEffect } from 'react';
import { formatTimeAgo } from '@/lib/dates';
import { AlertCircle, CheckCircle2, Clock, FileText, Trash2, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { MeetingMetadata, StoredTranscript } from '@/services/indexedDBService';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useI18n } from '@/i18n';

interface TranscriptRecoveryProps {
  isOpen: boolean;
  onClose: () => void;
  recoverableMeetings: MeetingMetadata[];
  onRecover: (meetingId: string) => Promise<any>;
  onDelete: (meetingId: string) => Promise<void>;
  onLoadPreview: (meetingId: string) => Promise<StoredTranscript[]>;
}

export function TranscriptRecovery({
  isOpen,
  onClose,
  recoverableMeetings,
  onRecover,
  onDelete,
  onLoadPreview,
}: TranscriptRecoveryProps) {
  const { t } = useI18n();
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [previewTranscripts, setPreviewTranscripts] = useState<StoredTranscript[]>([]);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Reset selection when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedMeetingId(null);
      setPreviewTranscripts([]);
    }
  }, [isOpen]);

  // Auto-select first meeting if available
  useEffect(() => {
    if (isOpen && recoverableMeetings.length > 0 && !selectedMeetingId) {
      handleMeetingSelect(recoverableMeetings[0].meetingId);
    }
  }, [isOpen, recoverableMeetings]);

  const handleMeetingSelect = async (meetingId: string) => {
    setSelectedMeetingId(meetingId);
    setIsLoadingPreview(true);

    try {
      const transcripts = await onLoadPreview(meetingId);
      // Limit to first 10 for preview
      setPreviewTranscripts(transcripts.slice(0, 10));
    } catch (error) {
      console.error('Failed to load preview:', error);
      setPreviewTranscripts([]);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleRecover = async () => {
    if (!selectedMeetingId) return;

    setIsRecovering(true);
    try {
      const result = await onRecover(selectedMeetingId);
      console.log('Recovery successful:', result);
      onClose();
    } catch (error) {
      console.error('Recovery failed:', error);
      toast.error(t('importing.recoverToastFailed'), { description: t('importing.recoveryToastFailedDescription') });
    } finally {
      setIsRecovering(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    if (!selectedMeetingId) return;
    setIsDeleting(true);
    try {
      await onDelete(selectedMeetingId);
      setSelectedMeetingId(null);
      setPreviewTranscripts([]);
    } catch (error) {
      console.error('Delete failed:', error);
      toast.error(t('importing.deleteToastFailed'), { description: t('importing.recoveryToastFailedDescription') });
    } finally {
      setIsDeleting(false);
    }
  };

  const selectedMeeting = recoverableMeetings.find(m => m.meetingId === selectedMeetingId);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="text-2xl">{t('importing.recoverTitle')}</DialogTitle>
          <DialogDescription>
            {recoverableMeetings.length !== 1
              ? t('importing.recoverDescriptionMany', { count: recoverableMeetings.length })
              : t('importing.recoverDescriptionOne', { count: recoverableMeetings.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 px-6 pb-6 overflow-hidden">
          {/* Meeting List */}
          <div className="w-1/3 flex flex-col">
            <h3 className="text-sm font-medium mb-2">{t('importing.interruptedMeetings')}</h3>
            <ScrollArea className="flex-1 border rounded-lg">
              <div className="p-2 space-y-2">
                {recoverableMeetings.map((meeting) => (
                  <button
                    key={meeting.meetingId}
                    onClick={() => handleMeetingSelect(meeting.meetingId)}
                    className={cn(
                      'w-full text-left p-3 rounded-lg border transition-colors',
                      selectedMeetingId === meeting.meetingId
                        ? 'bg-primary/10 border-primary'
                        : 'hover:bg-muted border-transparent'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{meeting.title}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <Clock className="w-3 h-3" />
                          {formatTimeAgo(new Date(meeting.lastUpdated))}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <FileText className="w-3 h-3" />
                          {meeting.transcriptCount === 1
                            ? t('importing.transcriptCountOne', { count: meeting.transcriptCount })
                            : t('importing.transcriptsCount', { count: meeting.transcriptCount })}
                        </p>
                      </div>
                      {meeting.folderPath ? (
                        <span title={t('importing.audioAvailable')}>
                          <CheckCircle2 className="w-4 h-4 text-af-success flex-shrink-0" />
                        </span>
                      ) : (
                        <span title={t('importing.noAudio')}>
                          <AlertCircle className="w-4 h-4 text-af-warning flex-shrink-0" />
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Preview Panel */}
          <div className="flex-1 flex flex-col">
            <h3 className="text-sm font-medium mb-2">{t('importing.preview')}</h3>
            <div className="flex-1 border rounded-lg overflow-hidden flex flex-col">
              {selectedMeeting ? (
                <>
                  {/* Meeting Info */}
                  <div className="p-4 border-b bg-muted/50">
                    <h4 className="font-semibold">{selectedMeeting.title}</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('importing.startedAt', { date: new Date(selectedMeeting.startTime).toLocaleString() })}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-sm">
                      <span className="flex items-center gap-1">
                        <FileText className="w-4 h-4" />
                        {t('importing.transcriptsCount', { count: selectedMeeting.transcriptCount })}
                      </span>
                      {selectedMeeting.folderPath ? (
                        <span className="flex items-center gap-1 text-af-success">
                          <CheckCircle2 className="w-4 h-4" />
                          {t('importing.audioAvailable')}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-af-warning">
                          <AlertCircle className="w-4 h-4" />
                          {t('importing.noAudio')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Transcript Preview */}
                  <ScrollArea className="flex-1 p-4">
                    {isLoadingPreview ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        {t('importing.loadingPreview')}
                      </div>
                    ) : previewTranscripts.length > 0 ? (
                      <div className="space-y-3">
                        <Alert>
                          <AlertDescription>
                            {t('importing.showingFirstSegments', {
                              shown: previewTranscripts.length,
                              total: selectedMeeting.transcriptCount,
                            })}
                          </AlertDescription>
                        </Alert>
                        {previewTranscripts.map((transcript, index) => {
                          // Handle different timestamp formats
                          const getTimestamp = () => {
                            if (!transcript.timestamp) return '--:--';
                            try {
                              const date = new Date(transcript.timestamp);
                              if (isNaN(date.getTime())) {
                                // If timestamp is invalid, try audio_start_time
                                if (transcript.audio_start_time !== undefined) {
                                  const totalSecs = Math.floor(transcript.audio_start_time);
                                  const mins = Math.floor(totalSecs / 60);
                                  const secs = totalSecs % 60;
                                  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                                }
                                return '--:--';
                              }
                              return date.toLocaleTimeString();
                            } catch {
                              return '--:--';
                            }
                          };

                          return (
                            <div key={index} className="text-sm">
                              <span className="text-muted-foreground">[{getTimestamp()}]</span>{' '}
                              <span>{transcript.text}</span>
                            </div>
                          );
                        })}
                        {selectedMeeting.transcriptCount > 10 && (
                          <p className="text-sm text-muted-foreground italic">
                            {selectedMeeting.transcriptCount - 10 === 1
                              ? t('importing.andMoreTranscriptOne', { count: selectedMeeting.transcriptCount - 10 })
                              : t('importing.andMoreTranscripts', { count: selectedMeeting.transcriptCount - 10 })}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        {t('importing.noTranscriptsToPreview')}
                      </div>
                    )}
                  </ScrollArea>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {t('importing.selectMeetingToPreview')}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 pb-6">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isRecovering || isDeleting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger-ghost"
            onClick={() => setConfirmDelete(true)}
            disabled={!selectedMeetingId || isRecovering || isDeleting}
            loading={isDeleting}
          >
            <Trash2 />
            {t('common.delete')}
          </Button>
          <Button
            onClick={handleRecover}
            disabled={!selectedMeetingId || isRecovering || isDeleting}
            loading={isRecovering}
          >
            <CheckCircle2 />
            {t('importing.recover')}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="danger"
        title={t('importing.deleteUnsavedTitle')}
        description={t('importing.deleteUnsavedDescription')}
        confirmLabel={t('common.delete')}
        onConfirm={handleDelete}
      />
    </Dialog>
  );
}
