'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, CheckCircle2, ExternalLink, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  CLAUDE_CODE_INSTALL_URL,
  ClaudeCliStatus,
  claudeCliBlockingReason,
  getClaudeCliStatus,
  testClaudeCliConnection,
} from '@/lib/claude-cli';

interface ClaudeCliSettingsProps {
  /** Path override the user is editing; empty string means auto-discover. */
  path: string;
  onPathChange: (path: string) => void;
  /** Model alias to use when testing, so the test matches what summaries will do. */
  model: string;
  /** Lets the parent gate Save on the CLI actually being usable. */
  onStatusChange?: (status: ClaudeCliStatus | null) => void;
}

/**
 * Status panel for the Claude Code CLI summary provider.
 *
 * There is no API key to collect here: the CLI is already signed in, or it is
 * not. So the panel's whole job is to say which of those is true, and to make
 * the fix obvious when it is the latter.
 */
export function ClaudeCliSettings({
  path,
  onPathChange,
  model,
  onStatusChange,
}: ClaudeCliSettingsProps) {
  const [status, setStatus] = useState<ClaudeCliStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const refresh = useCallback(
    async (pathOverride?: string) => {
      setIsChecking(true);
      setTestResult(null);
      try {
        const trimmed = (pathOverride ?? path).trim();
        const next = await getClaudeCliStatus(trimmed ? trimmed : null);
        setStatus(next);
        onStatusChange?.(next);
      } catch (error) {
        const failed: ClaudeCliStatus = {
          installed: false,
          api_key_env_detected: false,
          error: error instanceof Error ? error.message : String(error),
        };
        setStatus(failed);
        onStatusChange?.(failed);
      } finally {
        setIsChecking(false);
      }
    },
    [path, onStatusChange]
  );

  // Probe once on mount. Re-probing on every keystroke of the path field would
  // spawn a process per character, so the path is only re-checked on demand.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const trimmed = path.trim();
      const result = await testClaudeCliConnection(trimmed ? trimmed : null, model || null);
      setTestResult({ ok: result.status === 'success', message: result.message });
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsTesting(false);
    }
  };

  const blockingReason = claudeCliBlockingReason(status);
  const auth = status?.auth;

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <h4 className="text-sm font-semibold">Claude Code CLI</h4>
        <p className="text-xs text-muted-foreground mt-1">
          Summaries run through the <code className="text-[11px]">claude</code> command on this
          computer, so they use your Claude subscription instead of a pay-as-you-go API key. No key
          is stored here — the CLI handles sign-in.
        </p>
      </div>

      {/* Detection result */}
      <div className="rounded-xl border border-af-border bg-af-panel-2 p-3 text-sm">
        {isChecking && !status ? (
          <div className="flex items-center text-muted-foreground">
            <Spinner className="mr-2 h-4 w-4" />
            Looking for the Claude Code CLI…
          </div>
        ) : status?.installed ? (
          <div className="space-y-1">
            <div className="flex items-center font-medium text-af-success">
              <CheckCircle2 className="mr-2 h-4 w-4 shrink-0" />
              Found {status.version}
            </div>
            {status.path && (
              <p className="break-all text-xs text-muted-foreground">{status.path}</p>
            )}
            {auth?.loggedIn ? (
              <p className="text-xs text-muted-foreground">
                Signed in
                {auth.email ? ` as ${auth.email}` : ''}
                {auth.subscriptionType ? ` · ${auth.subscriptionType} plan` : ''}
                {auth.orgName ? ` · ${auth.orgName}` : ''}
              </p>
            ) : (
              <p className="flex items-start text-xs text-af-warning">
                <AlertTriangle className="mr-1.5 mt-0.5 h-3.5 w-3.5 shrink-0" />
                Not signed in. Run <code className="mx-1">claude auth login</code> in a terminal,
                then re-check.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-start font-medium text-af-danger">
              <XCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
              <span>{status?.error ?? 'Claude Code CLI not found.'}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                invoke('open_external_url', { url: CLAUDE_CODE_INSTALL_URL }).catch(() => {})
              }
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              Install Claude Code
            </Button>
          </div>
        )}
      </div>

      {/* An API key in the environment silently overrides the subscription, which
          defeats the point of choosing this provider. */}
      {status?.api_key_env_detected && (
        <p className="flex items-start rounded-lg bg-af-warning/10 p-2 text-xs text-af-text">
          <AlertTriangle className="mr-1.5 mt-0.5 h-3.5 w-3.5 shrink-0 text-af-warning" />
          <span>
            <code>ANTHROPIC_API_KEY</code> is set in this app&apos;s environment. The CLI prefers
            that key over your subscription, so summaries would be billed per token. Unset it to use
            the subscription.
          </span>
        </p>
      )}

      <div>
        <Label htmlFor="claude-cli-path">CLI path (optional)</Label>
        <Input
          id="claude-cli-path"
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder="Leave empty to find claude automatically"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Only needed when <code className="text-[11px]">claude</code> is installed somewhere
          unusual.
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => refresh()}
          disabled={isChecking}
          className="flex-1"
        >
          {isChecking ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              Checking…
            </>
          ) : (
            'Re-check'
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={runTest}
          disabled={isTesting || !!blockingReason}
          className="flex-1"
          title={blockingReason ?? 'Send a one-word prompt through the CLI'}
        >
          {isTesting ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              Testing…
            </>
          ) : (
            'Test summary call'
          )}
        </Button>
      </div>

      {testResult && (
        <p
          className={`text-xs ${testResult.ok ? 'text-af-success' : 'text-af-danger'}`}
        >
          {testResult.message}
        </p>
      )}
    </div>
  );
}
