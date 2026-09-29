import React from 'react';
import { AlertTriangle, Mic, RefreshCw, Speaker } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useIsLinux } from '@/hooks/usePlatform';

interface PermissionWarningProps {
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
  onRecheck: () => void;
  isRechecking?: boolean;
  className?: string;
}

/** Explains a missing microphone or system audio permission, with ways to fix it. */
export function PermissionWarning({
  hasMicrophone,
  hasSystemAudio,
  onRecheck,
  isRechecking = false,
  className,
}: PermissionWarningProps) {
  const isLinux = useIsLinux();

  // Linux has no permission prompts; nothing to explain when both work.
  if (isLinux || (hasMicrophone && hasSystemAudio)) return null;

  const isMacOS = navigator.userAgent.includes('Mac');
  const openSettings = (preferencePane: string) =>
    invoke('open_system_settings', { preferencePane }).catch((error) =>
      console.error(`Failed to open ${preferencePane} settings:`, error),
    );

  const title = !hasMicrophone && !hasSystemAudio
    ? 'Meetily can’t hear your microphone or computer audio'
    : !hasMicrophone
      ? 'Meetily can’t hear your microphone'
      : 'Meetily can’t record computer audio';

  return (
    <Alert variant="warning" className={className}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2 text-af-text-2">
        {!hasMicrophone && (
          <p>
            No microphone was found. Check that one is connected, that Meetily is allowed to use it in your system settings, and that no other
            app has taken it over.
          </p>
        )}
        {!hasSystemAudio && (
          <p>
            {hasMicrophone
              ? 'You can still record your microphone, but the other side of the call won’t be captured.'
              : 'Computer audio capture is unavailable too.'}
            {isMacOS && ' On macOS, allow Audio Capture for Meetily, play some audio, then check again. Restart Meetily if it stays silent.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {isMacOS && !hasMicrophone && (
            <Button size="sm" variant="secondary" onClick={() => openSettings('Privacy_Microphone')}>
              <Mic />
              Microphone settings
            </Button>
          )}
          {isMacOS && !hasSystemAudio && (
            <Button size="sm" variant="secondary" onClick={() => openSettings('Privacy_AudioCapture')}>
              <Speaker />
              Audio Capture settings
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onRecheck} disabled={isRechecking}>
            <RefreshCw className={isRechecking ? 'animate-spin' : undefined} />
            Check again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
