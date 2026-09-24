//! Claude Code CLI summary provider.
//!
//! Runs the user's locally installed `claude` executable in print mode instead of
//! calling the Anthropic HTTP API, so summaries are billed against a Claude
//! subscription rather than a pay-as-you-go API key. Nothing is bundled: the
//! provider only works when the user has already installed and signed in to the
//! Claude Code CLI themselves.

pub mod claude_cli;
pub mod commands;

pub use claude_cli::*;
