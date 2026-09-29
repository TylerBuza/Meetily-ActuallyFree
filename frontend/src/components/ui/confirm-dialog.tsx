"use client"

import * as React from "react"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` for destructive actions (delete, remove). */
  variant?: "default" | "danger"
  onConfirm: () => void | Promise<void>
}

/** The app's one confirmation dialog. Confirm shows progress while it runs. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
}: ConfirmDialogProps) {
  const [working, setWorking] = React.useState(false)

  const confirm = async () => {
    setWorking(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader className="pr-0">
          <div className="flex items-start gap-3">
            {variant === "danger" && (
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-af-danger/[0.12] text-af-danger">
                <AlertTriangle className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 space-y-1">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={working}>
            {cancelLabel}
          </Button>
          <Button variant={variant === "danger" ? "danger" : "primary"} onClick={confirm} loading={working} autoFocus>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
