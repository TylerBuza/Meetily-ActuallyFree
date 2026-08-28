'use client'

import './globals.css'
import { Source_Sans_3 } from 'next/font/google'
import Sidebar from '@/components/Sidebar'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import MainContent from '@/components/MainContent'
import AnalyticsProvider from '@/components/AnalyticsProvider'
import { Toaster, toast } from 'sonner'
import "sonner/dist/styles.css"
import { useState, useEffect, useCallback } from 'react'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { applyAppTheme, getSavedAppTheme } from '@/lib/app-theme'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'
import { OllamaDownloadProvider } from '@/contexts/OllamaDownloadContext'
import { TranscriptProvider } from '@/contexts/TranscriptContext'
import { ConfigProvider, useConfig } from '@/contexts/ConfigContext'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { OnboardingFlow } from '@/components/onboarding'
import { loadBetaFeatures } from '@/types/betaFeatures'
import { DownloadProgressToastProvider } from '@/components/shared/DownloadProgressToast'
import { UpdateCheckProvider } from '@/components/UpdateCheckProvider'
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider'
import { ImportAudioDialog, ImportDropOverlay } from '@/components/ImportAudio'
import { ImportDialogProvider } from '@/contexts/ImportDialogContext'
import { isAudioExtension, getAudioFormatsDisplayList } from '@/constants/audioFormats'
import GlobalSearchDialog from '@/components/GlobalSearchDialog'
import CrashReportDialog from '@/components/CrashReportDialog'
import { getPendingCrashReport, type PendingCrashReport } from '@/services/crashReportService'
import { Button } from '@/components/ui/button'


const sourceSans3 = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-source-sans-3',
})

// Module-level component — stable reference across RootLayout re-renders.
// Defined here (not inside RootLayout) so React never sees a new function type
// on re-render, which would cause unmount/remount and break initialization logic.
function ConditionalImportDialog({
  showImportDialog,
  handleImportDialogClose,
  importFilePath,
}: {
  showImportDialog: boolean;
  handleImportDialogClose: (open: boolean) => void;
  importFilePath: string | null;
}) {
  const { betaFeatures } = useConfig();

  // Only mount ImportAudioDialog (and its hooks/listeners) when feature is enabled
  if (!betaFeatures.importAndRetranscribe) {
    return null;
  }

  return (
    <ImportAudioDialog
      open={showImportDialog}
      onOpenChange={handleImportDialogClose}
      preselectedFile={importFilePath}
    />
  );
}

// export { metadata } from './metadata'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(false)
  const [startupResolved, setStartupResolved] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupAttempt, setStartupAttempt] = useState(0)
  const [pendingCrashReport, setPendingCrashReport] = useState<PendingCrashReport | null>(null)

  // Import audio state
  const [showDropOverlay, setShowDropOverlay] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFilePath, setImportFilePath] = useState<string | null>(null)

  // Apply saved theme (default: dark). Toggle lives in Settings.
  useEffect(() => {
    applyAppTheme(getSavedAppTheme())
  }, [])

  useEffect(() => {
    let cancelled = false

    const initializeStartup = async () => {
      setStartupResolved(false)
      setStartupError(null)
      try {
        const status = await invoke<{ completed: boolean } | null>('get_onboarding_status')
        if (cancelled) return
        const isComplete = status?.completed ?? false
        setOnboardingCompleted(isComplete)

        if (!isComplete) {
          console.log('[Layout] Onboarding not completed, showing onboarding flow')
          setShowOnboarding(true)
        } else {
          console.log('[Layout] Onboarding completed, showing main app')
          const report = await getPendingCrashReport()
          if (!cancelled) setPendingCrashReport(report)
        }
      } catch (error) {
        console.error('[Layout] Failed to resolve startup state:', error)
        if (cancelled) return
        setStartupError('Meetily could not verify local startup and crash-report state.')
      } finally {
        if (!cancelled) setStartupResolved(true)
      }
    }

    initializeStartup()
    return () => {
      cancelled = true
    }
  }, [startupAttempt])

  // Disable context menu in production
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      const handleContextMenu = (e: MouseEvent) => e.preventDefault();
      document.addEventListener('contextmenu', handleContextMenu);
      return () => document.removeEventListener('contextmenu', handleContextMenu);
    }
  }, []);
  useEffect(() => {
    if (!startupResolved || startupError || pendingCrashReport) return
    // Listen for tray recording toggle request
    const unlisten = listen('request-recording-toggle', () => {
      console.log('[Layout] Received request-recording-toggle from tray');

      if (showOnboarding) {
        toast.error("Please complete setup first", {
          description: "You need to finish onboarding before you can start recording."
        });
      } else {
        // If in main app, forward to useRecordingStart via window event
        console.log('[Layout] Forwarding to start-recording-from-sidebar');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [showOnboarding, startupResolved, startupError, pendingCrashReport]);

  // Meeting Detection: prompt to start recording when a meeting app is detected.
  useEffect(() => {
    if (!startupResolved || startupError || pendingCrashReport) return
    const unlisten = listen<{ app: string; process: string; notify: boolean }>(
      'meeting-detected',
      (event) => {
        const { app, notify } = event.payload;
        console.log('[Layout] meeting-detected:', event.payload);

        const startRecording = () => {
          if (showOnboarding) {
            toast.error('Please complete setup first', {
              description: 'Finish onboarding before you can start recording.',
            });
            return;
          }
          window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
        };

        // OS toast with a Start recording button (Windows native path).
        if (notify) {
          invoke('show_simple_notification', {
            title: `${app} meeting detected`,
            body: 'Start recording this meeting now?',
          }).catch(() => {});
        }

        // In-app prompt with a one-click start action.
        toast(`${app} meeting detected`, {
          description: 'Capture mic + system audio in Meetily.',
          duration: 20000,
          action: {
            label: 'Start recording',
            onClick: startRecording,
          },
        });
      }
    );

    // OS notification button → same start path as sidebar / in-app toast.
    const unlistenStart = listen('start-recording-from-notification', () => {
      if (showOnboarding) {
        toast.error('Please complete setup first', {
          description: 'Finish onboarding before you can start recording.',
        });
        return;
      }
      window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenStart.then((fn) => fn());
    };
  }, [showOnboarding, startupResolved, startupError, pendingCrashReport]);

  // Handle file drop for audio import
  const handleFileDrop = useCallback((paths: string[]) => {
    // Check if beta features are enabled (read from localStorage directly since we're outside ConfigProvider)
    const betaFeatures = loadBetaFeatures();

    if (!betaFeatures.importAndRetranscribe) {
      toast.error('Beta feature disabled', {
        description: 'Enable "Import Audio & Retranscribe" in Settings > Beta to use this feature.'
      });
      return;
    }

    // Find the first audio file
    const audioFile = paths.find(p => {
      const ext = p.split('.').pop()?.toLowerCase();
      return !!ext && isAudioExtension(ext);
    });

    if (audioFile) {
      console.log('[Layout] Audio file dropped:', audioFile);
      setImportFilePath(audioFile);
      setShowImportDialog(true);
    } else if (paths.length > 0) {
      toast.error('Please drop an audio file', {
        description: `Supported formats: ${getAudioFormatsDisplayList()}`
      });
    }
  }, []);

  // Listen for drag-drop events
  useEffect(() => {
    if (!startupResolved || startupError || pendingCrashReport || showOnboarding) return

    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Drag enter/over - show overlay only if beta feature is enabled
      const unlistenDragEnter = await listen('tauri://drag-enter', () => {
        if (loadBetaFeatures().importAndRetranscribe) {
          setShowDropOverlay(true);
        }
      });
      if (cleanedUpRef.current) {
        unlistenDragEnter();
        return;
      }
      unlisteners.push(unlistenDragEnter);

      // Drag leave - hide overlay
      const unlistenDragLeave = await listen('tauri://drag-leave', () => {
        setShowDropOverlay(false);
      });
      if (cleanedUpRef.current) {
        unlistenDragLeave();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenDragLeave);

      // Drop - process files
      const unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        setShowDropOverlay(false);
        handleFileDrop(event.payload.paths);
      });
      if (cleanedUpRef.current) {
        unlistenDrop();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenDrop);
    };

    setupListeners();

    return () => {
      cleanedUpRef.current = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [showOnboarding, startupResolved, startupError, pendingCrashReport, handleFileDrop]);

  // Handle import dialog close
  const handleImportDialogClose = useCallback((open: boolean) => {
    setShowImportDialog(open);
    if (!open) {
      setImportFilePath(null);
    }
  }, []);

  // Handler for ImportDialogProvider - opens import dialog from any child component
  const handleOpenImportDialog = useCallback((filePath?: string | null) => {
    setImportFilePath(filePath ?? null);
    setShowImportDialog(true);
  }, []);

  const handleOnboardingComplete = () => {
    console.log('[Layout] Onboarding completed, reloading app')
    setShowOnboarding(false)
    setOnboardingCompleted(true)
    // Optionally reload the window to ensure all state is fresh
    window.location.reload()
  }

  // The compact recording bar lives in its own tiny frameless window and must
  // render bare: mounting the app chrome here put the collapsed sidebar (the
  // logo square) and the floating Ask-AI button inside a 520×76 overlay, and
  // their opaque backgrounds squared off the window's rounded corners.
  // Checked via location rather than usePathname so no hook order changes.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/minibar')) {
    return (
      <html lang="en" className="dark minibar-window">
        <body className={`${sourceSans3.variable} font-sans antialiased bg-transparent`}>
          {children}
        </body>
      </html>
    )
  }

  return (
    <html lang="en" className="dark">
      <body className={`${sourceSans3.variable} font-sans antialiased`}>
        {!startupResolved ? (
          <div className="h-screen bg-[var(--af-bg)]" />
        ) : startupError ? (
          <div className="flex h-screen items-center justify-center bg-[var(--af-bg)] px-6">
            <div className="max-w-md rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-6 text-center shadow-xl">
              <h1 className="text-lg font-semibold text-[var(--af-text)]">Startup check failed</h1>
              <p className="mt-2 text-sm text-[var(--af-text-2)]">{startupError}</p>
              <Button className="mt-5" onClick={() => setStartupAttempt((value) => value + 1)}>
                Retry
              </Button>
            </div>
          </div>
        ) : pendingCrashReport ? (
          <>
            <div className="h-screen bg-[var(--af-bg)]" />
            <CrashReportDialog
              report={pendingCrashReport}
              onResolved={() => setPendingCrashReport(null)}
            />
          </>
        ) : (
          <AnalyticsProvider>
            <RecordingStateProvider>
              <TranscriptProvider>
                <ConfigProvider>
                  <OllamaDownloadProvider>
                    <OnboardingProvider>
                      <SidebarProvider>
                        <TooltipProvider>
                          <RecordingPostProcessingProvider>
                            <UpdateCheckProvider onboardingCompleted={onboardingCompleted}>
                              {onboardingCompleted && !showOnboarding && <GlobalSearchDialog />}
                              <ImportDialogProvider onOpen={handleOpenImportDialog}>
                                {/* Download progress toast provider - listens for background downloads */}
                                <DownloadProgressToastProvider />

                                {/* Show onboarding or main app */}
                                {showOnboarding ? (
                                  <OnboardingFlow onComplete={handleOnboardingComplete} />
                                ) : (
                                  <div className="flex min-h-0 min-w-0 h-screen overflow-hidden">
                                    <Sidebar />
                                    <MainContent>{children}</MainContent>
                                  </div>
                                )}
                                {/* Import audio overlay and dialog */}
                                <ImportDropOverlay visible={showDropOverlay} />
                                <ConditionalImportDialog
                                  showImportDialog={showImportDialog}
                                  handleImportDialogClose={handleImportDialogClose}
                                  importFilePath={importFilePath}
                                />
                              </ImportDialogProvider>
                            </UpdateCheckProvider>
                          </RecordingPostProcessingProvider>
                        </TooltipProvider>
                      </SidebarProvider>
                    </OnboardingProvider>
                  </OllamaDownloadProvider>
                </ConfigProvider>
              </TranscriptProvider>
            </RecordingStateProvider>
          </AnalyticsProvider>
        )}

        <Toaster position="bottom-center" theme="dark" richColors closeButton />
      </body>
    </html>
  )
}
