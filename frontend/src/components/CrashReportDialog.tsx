'use client'

import { useState } from 'react'
import { FileArchive, Loader2, Send, ShieldCheck } from 'lucide-react'
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

interface CrashReportDialogProps {
  report: PendingCrashReport
  onResolved: () => void
}

type PendingAction = 'send' | 'save' | 'ignore' | null

export default function CrashReportDialog({ report, onResolved }: CrashReportDialogProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const busy = pendingAction !== null

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
      toast.warning('The report could not be dismissed permanently', {
        description: 'You can continue now, but Meetily may ask about it again next launch.',
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
      toast.success('Crash report saved', { description: destination })
    } catch (error) {
      console.error('[CrashReport] Failed to save report:', error)
      toast.error('Could not save the crash report')
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
      toast.success('Crash report ready to attach', {
        description: 'GitHub opened with the report details. Attach the ZIP you just saved.',
      })
    } catch (error) {
      console.error('[CrashReport] Failed to prepare report:', error)
      toast.error('Could not prepare the crash report')
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
    ? 'the previous session'
    : detected.toLocaleString()
  const description = report.crashType === 'panic'
    ? 'Meetily encountered an internal error during the previous session.'
    : 'Meetily did not shut down cleanly during the previous session.'

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="max-h-[calc(100vh-2rem)] max-w-[520px] gap-0 overflow-y-auto border-[var(--af-border)] bg-[var(--af-panel)] p-0 shadow-2xl"
      >
        <div className="border-b border-[var(--af-border)] bg-gradient-to-br from-red-500/10 via-transparent to-transparent px-6 py-5">
          <DialogHeader className="text-left">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-red-400/25 bg-red-500/10 text-red-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <DialogTitle className="text-xl text-[var(--af-text)]">
              Meetily encountered a problem
            </DialogTitle>
            <DialogDescription className="text-[var(--af-text-2)]">
              {description} Creating or ignoring this report does not include or modify meeting content.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="rounded-lg border border-[var(--af-border)] bg-black/10 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[var(--af-text-3)]">Detected</span>
              <span className="text-right text-[var(--af-text-2)]">{detectedLabel}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <span className="text-[var(--af-text-3)]">Version</span>
              <span className="font-mono text-[var(--af-text-2)]">{report.appVersion}</span>
            </div>
          </div>

          <details className="group rounded-lg border border-[var(--af-border)] bg-black/10 px-4 py-3 text-sm">
            <summary className="cursor-pointer select-none rounded font-medium text-[var(--af-text-2)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--af-accent)]">
              What&apos;s included?
            </summary>
            <div className="mt-3 space-y-2 border-t border-[var(--af-border)] pt-3 text-xs leading-relaxed text-[var(--af-text-3)]">
              <p>Crash time and type, Meetily version, coarse operating-system details, bucketed CPU core count, rounded memory size, acceleration backend, and source-relative panic file/line details with a location fingerprint when available.</p>
              <p>No audio, recordings, transcripts, summaries, meeting names, database, settings, credentials, usernames, hostnames, or device names.</p>
            </div>
          </details>

          <p className="text-xs leading-relaxed text-[var(--af-text-3)]">
            Send Report asks where to save the private ZIP, then opens a public GitHub issue. Opening GitHub contacts GitHub; the ZIP stays local until you choose it as an attachment, which uploads it before issue submission.
          </p>

          <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
            <Button variant="ghost" onClick={handleIgnore} disabled={busy}>
              {pendingAction === 'ignore' && <Loader2 className="animate-spin" />}
              Ignore
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={busy}>
              {pendingAction === 'save' ? <Loader2 className="animate-spin" /> : <FileArchive />}
              Save ZIP
            </Button>
            <Button onClick={handleSend} disabled={busy}>
              {pendingAction === 'send' ? <Loader2 className="animate-spin" /> : <Send />}
              Send Report
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
