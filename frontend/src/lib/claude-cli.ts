/**
 * Claude Code CLI provider helpers.
 *
 * The 'claude-cli' summary provider runs the user's locally installed `claude`
 * executable instead of calling the Anthropic API, so summaries draw on a Claude
 * subscription rather than a pay-as-you-go key. Nothing here holds credentials —
 * the CLI owns sign-in — so the UI only ever asks the backend about status.
 */

import { invoke } from '@tauri-apps/api/core';

export interface ClaudeCliModel {
  id: string;
  display_name: string;
}

export interface ClaudeCliAuth {
  loggedIn: boolean;
  authMethod?: string | null;
  subscriptionType?: string | null;
  email?: string | null;
  orgName?: string | null;
}

export interface ClaudeCliStatus {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  auth?: ClaudeCliAuth | null;
  /** ANTHROPIC_API_KEY is set, so the CLI would bill per-token instead of the subscription. */
  api_key_env_detected: boolean;
  error?: string | null;
}

export interface ClaudeCliTestResult {
  status: string;
  message: string;
}

/** Model aliases shown in the picker; resolved by the CLI at call time. */
export const CLAUDE_CLI_FALLBACK_MODELS = ['sonnet', 'opus', 'haiku', 'default'];

export const CLAUDE_CLI_DEFAULT_MODEL = 'sonnet';

/** Where to send someone who does not have the CLI yet. */
export const CLAUDE_CODE_INSTALL_URL = 'https://claude.com/claude-code';

/**
 * Detect the CLI and read its sign-in state. Free — runs `--version` and
 * `auth status`, never a model.
 */
export async function getClaudeCliStatus(path?: string | null): Promise<ClaudeCliStatus> {
  return invoke<ClaudeCliStatus>('claude_cli_get_status', { path: path ?? null });
}

export async function listClaudeCliModels(): Promise<ClaudeCliModel[]> {
  return invoke<ClaudeCliModel[]>('claude_cli_list_models');
}

export async function getClaudeCliPath(): Promise<string | null> {
  return invoke<string | null>('claude_cli_get_path');
}

export async function saveClaudeCliPath(path: string | null): Promise<void> {
  return invoke<void>('claude_cli_save_path', { path });
}

/** Send a one-word prompt through the CLI. Costs a little subscription usage. */
export async function testClaudeCliConnection(
  path?: string | null,
  model?: string | null
): Promise<ClaudeCliTestResult> {
  return invoke<ClaudeCliTestResult>('claude_cli_test_connection', {
    path: path ?? null,
    model: model ?? null,
  });
}

/** True when the CLI is present and signed in, i.e. summaries can run. */
export function isClaudeCliReady(status: ClaudeCliStatus | null): boolean {
  return !!status?.installed && !!status.auth?.loggedIn;
}

/** A short, human explanation of why the provider is not usable yet. */
export function claudeCliBlockingReason(status: ClaudeCliStatus | null): string | null {
  if (!status) return 'Checking the Claude Code CLI…';
  if (!status.installed) {
    return status.error ?? 'Claude Code CLI not found.';
  }
  if (!status.auth?.loggedIn) {
    return 'The Claude Code CLI is installed but not signed in. Run `claude auth login` in a terminal.';
  }
  return null;
}
