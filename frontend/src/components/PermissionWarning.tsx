'use client';

import React from 'react';
import { AlertTriangle, Mic, RefreshCw, Speaker } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useIsLinux } from '@/hooks/usePlatform';
import type { SystemAudioPermission } from '@/hooks/usePermissionCheck';
import { useI18n } from '@/i18n';

interface PermissionWarningProps {
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
  systemAudioPermission?: SystemAudioPermission;
  onRecheck: () => void;
  isRechecking?: boolean;
  className?: string;
}

/** Explains a missing microphone or system audio permission, with ways to fix it. */
export function PermissionWarning({
  hasMicrophone,
  hasSystemAudio,
  systemAudioPermission = 'unknown',
  onRecheck,
  isRechecking = false,
  className,
}: PermissionWarningProps) {
  const { t } = useI18n();
  const isLinux = useIsLinux();

  // Linux has no permission prompts; nothing to explain when both work.
  if (isLinux || (hasMicrophone && hasSystemAudio)) return null;

  const isMacOS = navigator.userAgent.includes('Mac');
  const openSettings = (preferencePane: string) =>
    invoke('open_system_settings', { preferencePane }).catch((error) =>
      console.error(`Failed to open ${preferencePane} settings:`, error),
    );

  const title = !hasMicrophone && !hasSystemAudio
    ? t('importing.micAndAudioUnavailable')
    : !hasMicrophone
      ? t('importing.micUnavailable')
      : t('importing.systemAudioUnavailable');

  // What to do on macOS depends on what TCC reports; 'granted' with no output
  // device needs no permission advice.
  const macOSSystemAudioHint =
    systemAudioPermission === 'denied'
      ? t('importing.macAudioCaptureDenied')
      : systemAudioPermission === 'not_determined'
        ? t('importing.macAccessNotConfirmed')
        : systemAudioPermission === 'granted'
          ? ''
          : t('importing.macAudioCaptureUnknown');

  return (
    <Alert variant="warning" className={className}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2 text-af-text-2">
        {!hasMicrophone && (
          <p>
            {t('importing.noMicrophoneFound')}
          </p>
        )}
        {!hasSystemAudio && (
          <p>
            {hasMicrophone
              ? t('importing.canStillRecordMic')
              : t('importing.computerAudioUnavailable')}
            {isMacOS && macOSSystemAudioHint}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {isMacOS && !hasMicrophone && (
            <Button size="sm" variant="secondary" onClick={() => openSettings('Privacy_Microphone')}>
              <Mic />
              {t('importing.microphoneSettings')}
            </Button>
          )}
          {isMacOS && !hasSystemAudio && (
            <Button size="sm" variant="secondary" onClick={() => openSettings('Privacy_AudioCapture')}>
              <Speaker />
              {t('importing.audioCaptureSettings')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onRecheck} disabled={isRechecking}>
            <RefreshCw className={isRechecking ? 'animate-spin' : undefined} />
            {t('importing.checkAgain')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
