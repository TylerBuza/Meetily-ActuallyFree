'use client'
import { Spinner } from '@/components/ui/spinner';

import { useState, useEffect } from 'react'
import { FileArchive, Send, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  chooseCrashReportDestination,
  createCrashReportZip,
  dismissCrashReport,
  openCrashReportIssue,
  type PendingCrashReport,
} from '@/services/crashReportService'
import { useI18n } from '@/i18n'

interface CrashReportDialogProps {
  report: PendingCrashReport
  onResolved: () => void
}

type PendingAction = 'send' | 'save' | 'ignore' | null

export default function CrashReportDialog({ report, onResolved }: CrashReportDialogProps) {
  const { t } = useI18n()
  const [mounted, setMounted] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const busy = pendingAction !== null

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  const createZip = async () => {
    const destination = await chooseCrashReportDestination(report)
    if (!destination) return null
    return createCrashReportZip(destination)
  }

  const finishDialog = async () => {
    try {
      await dismissCrashReport()
    } catch (error) {
      console.error('[CrashReport] Failed to persist dismissal:', error)
      toast.warning(t('shell.crashDismissFailed'), {
        description: t('shell.crashDismissFailedDescription'),
      })
    }
    onResolved()
  }

  const handleSave = async () => {
    setPendingAction('save')
    try {
      const destination = await createZip()
      if (!destination) return
      await finishDialog()
      toast.success(t('shell.crashSaved'), { description: destination })
    } catch (error) {
      console.error('[CrashReport] Failed to save report:', error)
      toast.error(t('shell.crashSaveFailed'))
    } finally {
      setPendingAction(null)
    }
  }

  const handleSend = async () => {
    setPendingAction('send')
    try {
      const destination = await createZip()
      if (!destination) return
      await openCrashReportIssue(report)
      await finishDialog()
      toast.success(t('shell.crashReadyToAttach'), {
        description: t('shell.crashReadyToAttachDescription'),
      })
    } catch (error) {
      console.error('[CrashReport] Failed to prepare report:', error)
      toast.error(t('shell.crashPrepareFailed'))
    } finally {
      setPendingAction(null)
    }
  }

  const handleIgnore = async () => {
    setPendingAction('ignore')
    try {
      await finishDialog()
    } finally {
      setPendingAction(null)
    }
  }

  const detected = new Date(report.detectedAt)
  const detectedLabel = Number.isNaN(detected.getTime())
    ? t('shell.crashDetectedFallback')
    : detected.toLocaleString()
  const description = report.crashType === 'panic'
    ? t('shell.crashDescriptionPanic')
    : t('shell.crashDescriptionUnclean')

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="max-h-[calc(100vh-2rem)] max-w-[520px] gap-0 overflow-y-auto border-[var(--af-border)] bg-[var(--af-panel)] p-0 shadow-2xl"
      >
        <div className="border-b border-[var(--af-border)] bg-af-panel-2 via-transparent to-transparent px-6 py-5">
          <DialogHeader className="text-left">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-af-danger/35 bg-af-danger/10 text-af-danger">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <DialogTitle className="text-xl text-[var(--af-text)]">
              {t('shell.crashTitle')}
            </DialogTitle>
            <DialogDescription className="text-[var(--af-text-2)]">
              {description}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="rounded-lg border border-[var(--af-border)] bg-black/10 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[var(--af-text-3)]">{t('shell.detected')}</span>
              <span className="text-right text-[var(--af-text-2)]">{detectedLabel}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <span className="text-[var(--af-text-3)]">{t('shell.version')}</span>
              <span className="font-mono text-[var(--af-text-2)]">{report.appVersion}</span>
            </div>
          </div>

          <details className="group rounded-lg border border-[var(--af-border)] bg-black/10 px-4 py-3 text-sm">
            <summary className="cursor-pointer select-none rounded font-medium text-[var(--af-text-2)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--af-accent)]">
              {t('shell.whatsIncluded')}
            </summary>
            <div className="mt-3 space-y-2 border-t border-[var(--af-border)] pt-3 text-xs leading-relaxed text-[var(--af-text-3)]">
              <p>{t('shell.crashIncludedCrash')}</p>
              <p>{t('shell.crashIncludedTimeline')}</p>
              <p>{t('shell.crashIncludedExcluded')}</p>
            </div>
          </details>

          <p className="text-xs leading-relaxed text-[var(--af-text-3)]">
            {t('shell.crashSendExplainer')}
          </p>

          <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
            <Button variant="ghost" onClick={handleIgnore} disabled={busy}>
              {pendingAction === 'ignore' && <Spinner className="" />}
              {t('shell.ignore')}
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={busy}>
              {pendingAction === 'save' ? <Spinner className="" /> : <FileArchive />}
              {t('shell.saveZip')}
            </Button>
            <Button onClick={handleSend} disabled={busy}>
              {pendingAction === 'send' ? <Spinner className="" /> : <Send />}
              {t('shell.sendReport')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
