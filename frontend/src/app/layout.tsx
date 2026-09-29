'use client'

import './globals.css'
import './icon-motion.css'
import dynamic from 'next/dynamic'
import { Inter } from 'next/font/google'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import AnalyticsProvider from '@/components/AnalyticsProvider'
import { Toaster, toast } from 'sonner'
import { X } from 'lucide-react'
import "sonner/dist/styles.css"
import { useState, useEffect, useCallback, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { launchRecording, requestRecordingStop } from '@/lib/recording-launch'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { applyAppTheme, getSavedAppTheme, themeInfo, THEME_BOOT_SCRIPT, useAppTheme } from '@/lib/app-theme'
import { COMPACT_MIN_WIDTH } from '@/hooks/useCompactChrome'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppTooltipGuard } from '@/components/AppTooltipGuard'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'
import { OllamaDownloadProvider } from '@/contexts/OllamaDownloadContext'
import { TranscriptProvider } from '@/contexts/TranscriptContext'
import { ConfigProvider, useConfig } from '@/contexts/ConfigContext'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { OptionalModelDownloadsProvider } from '@/contexts/OptionalModelDownloadsContext'
import { DownloadProgressToastProvider } from '@/components/shared/DownloadProgressToast'
import { UpdateCheckProvider } from '@/components/UpdateCheckProvider'
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider'
import { ImportDialogProvider } from '@/contexts/ImportDialogContext'
import { isAudioExtension, getAudioFormatsDisplayList } from '@/constants/audioFormats'
import { loadLabsPreferences } from '@/lib/labs'
import { automatedRecording, endAutomatedRecording, markAutomatedStart } from '@/lib/meeting-automation'
import { getPendingCrashReport, type PendingCrashReport } from '@/services/crashReportService'
import { WorkspaceProvider } from '@/contexts/WorkspaceContext'
import { RouteWarmup } from '@/components/RouteWarmup'
import { CHROME_BOOT_SCRIPT } from '@/lib/window-chrome'
import { RecordingPill } from '@/components/recording/RecordingPill'
import { VoiceProfileNotifications } from '@/components/VoiceProfileNotifications'
import { GroupEditorHost } from '@/components/groups/GroupEditor'

// Development only: in a plain browser (no Tauri bridge) serve sample data so
// screens can be reviewed at http://localhost:3118. Stripped from production.
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/dev/preview').installPreviewMocks()
}

// Dynamically import heavy dialogs and onboarding wizard so app/layout.js stays lightweight
// and cold-compiles quickly without timing out on slow startup or high CPU load.
const OnboardingFlow = dynamic(
  () => import('@/components/onboarding').then((mod) => mod.OnboardingFlow),
  { ssr: false }
)
const ImportAudioDialog = dynamic(
  () => import('@/components/ImportAudio').then((mod) => mod.ImportAudioDialog),
  { ssr: false }
)
const ImportDropOverlay = dynamic(
  () => import('@/components/ImportAudio').then((mod) => mod.ImportDropOverlay),
  { ssr: false }
)
const GlobalSearchDialog = dynamic(
  () => import('@/components/GlobalSearchDialog'),
  { ssr: false }
)
const WindowControls = dynamic(
  () => import('@/components/WindowControls'),
  { ssr: false }
)
const CrashReportDialog = dynamic(
  () => import('@/components/CrashReportDialog'),
  { ssr: false }
)

const Sidebar = dynamic(
  () => import('@/components/Sidebar'),
  { ssr: false }
)
const MainContent = dynamic(
  () => import('@/components/MainContent'),
  { ssr: false }
)

// Early inline handler executed in <head> before chunk scripts evaluate.
// Catches ChunkLoadError (such as on-demand compilation delay on cold launch)
// and reloads the window after a brief pause so pre-compiled chunks load instantly.
const inlineChunkErrorHandler = `
(function() {
  var RELOAD_KEY = 'meetily_chunk_reload';
  function handleChunkError(e) {
    try {
      var msg = (e && e.message) || (e && e.reason && e.reason.message) || '';
      var name = (e && e.name) || (e && e.reason && e.reason.name) || '';
      var isChunkError = name === 'ChunkLoadError' ||
        /loading chunk .* failed/i.test(msg) ||
        /timeout: .*_next\\/static/i.test(msg) ||
        /failed to fetch .*_next\\/static/i.test(msg);

      if (isChunkError) {
        var last = sessionStorage.getItem(RELOAD_KEY);
        var now = Date.now();
        if (!last || (now - parseInt(last, 10)) > 3000) {
          sessionStorage.setItem(RELOAD_KEY, String(now));
          console.warn('[Meetily] ChunkLoadError detected in WebView2. Reloading in 300ms...');
          setTimeout(function() {
            window.location.reload();
          }, 300);
        }
      }
    } catch (_) {}
  }
  window.addEventListener('error', handleChunkError, true);
  window.addEventListener('unhandledrejection', handleChunkError, true);
})();
`;

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
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
  const pathname = usePathname()
  const router = useRouter()
  // Tray, notification and meeting-detection starts work from any page.
  const startRecordingAnywhere = useRef<() => void>(() => undefined)
  startRecordingAnywhere.current = () => launchRecording((href) => router.push(href))
  const isMinibar = (pathname ?? '').startsWith('/minibar')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(false)
  // Paint a retryable startup screen until native setup status is known.
  const [startupResolved, setStartupResolved] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupAttempt, setStartupAttempt] = useState(0)
  const [pendingCrashReport, setPendingCrashReport] = useState<PendingCrashReport | null>(null)

  // Import audio state
  const [showDropOverlay, setShowDropOverlay] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFilePath, setImportFilePath] = useState<string | null>(null)

  // THEME_BOOT_SCRIPT already painted the saved theme; this also syncs the
  // native title bar. useAppTheme follows changes from Settings and from the
  // other window.
  const [appTheme] = useAppTheme()
  useEffect(() => {
    applyAppTheme(getSavedAppTheme())
  }, [])

  // Keep the window wide enough for the expanded rail, its collapse control,
  // the recording card, and the speakers panel without those overlapping.
  useEffect(() => {
    if (isMinibar) return
    let cancelled = false
    void (async () => {
      try {
        const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        const min = new LogicalSize(COMPACT_MIN_WIDTH, 1)
        await win.setMinSize(min)
        const factor = await win.scaleFactor()
        const size = (await win.innerSize()).toLogical(factor)
        if (cancelled || size.width >= COMPACT_MIN_WIDTH) return
        await win.setSize(new LogicalSize(COMPACT_MIN_WIDTH, size.height))
      } catch {
        // Browser preview, or the desktop window is not available yet.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isMinibar])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) setStartupError('Setup status is taking longer than expected.')
    }, 8000)

    const initializeStartup = async () => {
      try {
        const status = await invoke<{ completed: boolean } | null>('get_onboarding_status')
        if (cancelled) return
        const isComplete = status?.completed ?? false
        window.clearTimeout(timer)
        setStartupError(null)
        setStartupResolved(true)
        setOnboardingCompleted(isComplete)
        setShowOnboarding(!isComplete)

        if (isComplete) {
          try {
            const report = await getPendingCrashReport()
            if (!cancelled) setPendingCrashReport(report)
          } catch (error) {
            console.warn('[Layout] Crash report check failed:', error)
          }
        }
      } catch (error) {
        console.warn('[Layout] Could not resolve Tauri startup state:', error)
        if (cancelled) return
        window.clearTimeout(timer)
        setStartupError('Unable to check setup status. Please retry.')
      }
    }

    void initializeStartup()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [startupAttempt])

  // Disable context menu in production
  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen<string>('live-diarization-error', event => {
      toast.error('Live speaker labeling unavailable', { description: event.payload, duration: 10000 });
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, []);

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
        startRecordingAnywhere.current();
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [showOnboarding, startupResolved, startupError, pendingCrashReport]);

  useEffect(() => {
    if (!startupResolved || startupError || pendingCrashReport) return
    const unlisten = listen<{ title: string; message: string }>(
      'recording-audio-route-warning',
      (event) => {
        toast.warning(event.payload.title, {
          description: event.payload.message,
          duration: 30000,
        });
        invoke('show_simple_notification', {
          title: event.payload.title,
          body: event.payload.message,
        }).catch(() => {});
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [startupResolved, startupError, pendingCrashReport]);

  // Meeting Detection: prompt to start recording when a meeting app is detected.
  // With Labs meeting automation on, a call that is using the microphone or
  // camera starts a recording instead, and that recording stops when the call
  // ends. The compact bar's window never starts or stops recordings.
  useEffect(() => {
    if (!startupResolved || startupError || pendingCrashReport || isMinibar) return
    const unlisten = listen<{ app: string; process: string; notify: boolean; active_media: boolean }>(
      'meeting-detected',
      (event) => {
        const { app, notify, active_media, process } = event.payload;
        console.log('[Layout] meeting-detected:', event.payload);

        const startRecording = () => {
          if (showOnboarding) {
            toast.error('Please complete setup first', {
              description: 'Finish onboarding before you can start recording.',
            });
            return;
          }
          startRecordingAnywhere.current();
        };

        if (loadLabsPreferences().meetingAutomation && active_media && !showOnboarding) {
          void invoke<{ is_recording?: boolean }>('get_recording_state').then((state) => {
            if (state.is_recording) return;
            markAutomatedStart({ app, process });
            startRecording();
          }).catch((error) => console.error('Could not check recording state for meeting automation:', error));
          return;
        }

        // Process-only detection means the app is open, not that a call began.
        const promptTitle = active_media ? `${app} meeting detected` : `${app} is open`;
        const promptBody = active_media
          ? 'Start recording this meeting now?'
          : 'Start recording if you are in a call?';
        // OS toast with a Start recording button (Windows native path).
        if (notify) {
          invoke('show_simple_notification', {
            title: promptTitle,
            body: promptBody,
          }).catch(() => {});
        }

        // In-app prompt with a one-click start action.
        toast(promptTitle, {
          description: active_media ? 'Capture mic + system audio in Meetily.' : promptBody,
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
      startRecordingAnywhere.current();
    });

    // Only a recording that automation started for this same call is stopped.
    const unlistenEnd = listen<{ app: string; process: string }>('meeting-ended', (event) => {
      const call = automatedRecording();
      if (!call || call.process !== event.payload.process || !loadLabsPreferences().meetingAutomation) return;
      void invoke<{ is_recording?: boolean }>('get_recording_state').then((state) => {
        if (!state.is_recording) {
          endAutomatedRecording();
          return;
        }
        toast(`${call.app} call ended`, { description: 'Meeting automation is stopping and saving the recording.' });
        requestRecordingStop((href) => router.push(href));
      }).catch((error) => console.error('Could not check recording state for meeting automation:', error));
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenStart.then((fn) => fn());
      unlistenEnd.then((fn) => fn());
    };
  }, [showOnboarding, startupResolved, startupError, pendingCrashReport, isMinibar, router]);

  // Handle file drop for audio import
  const handleFileDrop = useCallback((paths: string[]) => {
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
      // Dragging a file over the window shows the import overlay.
      const unlistenDragEnter = await listen('tauri://drag-enter', () => {
        setShowDropOverlay(true);
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

  // The compact bar is its own window. Render it bare on the server and the
  // client so the full app chrome never mounts there and then unmounts.
  if (isMinibar) {
    return (
      <html lang="en" data-theme="midnight" className={`dark minibar-window ${inter.variable} ${inter.className}`} suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
          <script dangerouslySetInnerHTML={{ __html: inlineChunkErrorHandler }} />
        </head>
        <body className="font-sans antialiased bg-transparent">
          {children}
        </body>
      </html>
    )
  }

  return (
    <html lang="en" data-theme="midnight" className={`dark ${inter.variable} ${inter.className}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: CHROME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: inlineChunkErrorHandler }} />
      </head>
      <body className="font-sans antialiased">
        {!startupResolved || startupError ? (
          <main className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--af-bg)] text-af-text">
            <p role="status">{startupError ?? 'Checking setup…'}</p>
            {startupError && <button onClick={() => { setStartupError(null); setStartupAttempt(value => value + 1); }}>Retry</button>}
          </main>
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
                      <WorkspaceProvider>
                      <OptionalModelDownloadsProvider>
                      <SidebarProvider>
                        <TooltipProvider>
                          <AppTooltipGuard />
                          <RecordingPostProcessingProvider>
                            <UpdateCheckProvider onboardingCompleted={onboardingCompleted}>
                              <ImportDialogProvider onOpen={handleOpenImportDialog}>
                                {onboardingCompleted && !showOnboarding && <GlobalSearchDialog />}
                                {onboardingCompleted && !showOnboarding && <RouteWarmup />}
                                {/* Download progress toast provider - listens for background downloads */}
                                <DownloadProgressToastProvider />

                                {/* Show onboarding or main app */}
                                {showOnboarding ? (
                                  <OnboardingFlow onComplete={handleOnboardingComplete} />
                                ) : (
                                  <div className="flex min-h-0 min-w-0 h-screen overflow-hidden">
                                    <Sidebar />
                                    <MainContent>{children}</MainContent>
                                    <VoiceProfileNotifications />
                                    <RecordingPill />
                                    <GroupEditorHost />
                                  </div>
                                )}
                                {/* Import audio overlay and dialog */}
                                <ImportDropOverlay visible={showDropOverlay} />
                                <ConditionalImportDialog
                                  showImportDialog={showImportDialog}
                                  handleImportDialogClose={handleImportDialogClose}
                                  importFilePath={importFilePath}
                                />
                                {/* Non-blocking crash report overlay */}
                                {pendingCrashReport && (
                                  <CrashReportDialog
                                    report={pendingCrashReport}
                                    onResolved={() => setPendingCrashReport(null)}
                                  />
                                )}
                              </ImportDialogProvider>
                            </UpdateCheckProvider>
                          </RecordingPostProcessingProvider>
                        </TooltipProvider>
                      </SidebarProvider>
                      </OptionalModelDownloadsProvider>
                      </WorkspaceProvider>
                    </OnboardingProvider>
                  </OllamaDownloadProvider>
                </ConfigProvider>
              </TranscriptProvider>
            </RecordingStateProvider>
          </AnalyticsProvider>
        )}

        {/* Minimize, maximize and close, drawn by the app on Windows. */}
        <WindowControls />

        <Toaster
          position="top-center"
          theme={themeInfo(appTheme).dark ? 'dark' : 'light'}
          closeButton
          offset="calc(var(--af-chrome-h) + 16px)"
          icons={{ close: <X className="h-4 w-4" /> }}
          toastOptions={{
            classNames: {
              toast: 'af-toast',
              title: 'text-sm font-medium text-af-text',
              description: 'text-xs text-af-text-2',
            },
          }}
        />
      </body>
    </html>
  )
}
