import React from 'react';
import { Spinner } from '@/components/ui/spinner';
import { CheckCircle2,  XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { PermissionRowProps } from '@/types/onboarding';

export function PermissionRow({ icon, title, description, status, isPending = false, onAction }: PermissionRowProps) {
  const isAuthorized = status === 'authorized';
  const isDenied = status === 'denied';
  const isChecking = isPending;

  const getButtonText = () => {
    if (isChecking) return 'Checking...';
    if (isDenied) return 'Open Settings';
    return 'Enable';
  };

  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-2xl border px-6 py-5',
        'transition-all duration-200',
        isAuthorized ? 'border-af-border-strong bg-af-panel-2' : isDenied ? 'border-af-danger/35 bg-af-danger/10' : 'bg-af-panel border-af-border'
      )}
    >
      {/* Left side: Icon + Info */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Icon */}
        <div
          className={cn(
            'flex size-10 items-center justify-center rounded-full flex-shrink-0',
            isAuthorized ? 'bg-af-hover' : isDenied ? 'bg-af-danger/10' : 'bg-af-panel-2'
          )}
        >
          <div className={cn(isAuthorized ? 'text-af-text' : isDenied ? 'text-af-danger' : 'text-af-text-3')}>{icon}</div>
        </div>

        {/* Title + Description */}
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate text-af-text">{title}</div>
          <div className="text-sm text-muted-foreground">
            {isAuthorized ? (
              <span className="text-af-success flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Access Granted
              </span>
            ) : isDenied ? (
              <span className="text-af-danger flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" />
                Access Denied - Please grant in System Settings
              </span>
            ) : (
              <span>{description}</span>
            )}
          </div>
        </div>
      </div>

      {/* Right side: Action button or checkmark */}
      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
        {!isAuthorized && (
          <Button
            variant={isDenied ? "destructive" : "outline"}
            size="sm"
            onClick={onAction}
            disabled={isChecking}
            className="min-w-[100px]"
          >
            {isChecking && <Spinner className="mr-2 h-4 w-4 " />}
            {getButtonText()}
          </Button>
        )}
        {isAuthorized && (
          <div className="flex size-8 items-center justify-center rounded-full bg-af-success/10">
            <CheckCircle2 className="w-4 h-4 text-af-success" />
          </div>
        )}
      </div>
    </div>
  );
}
