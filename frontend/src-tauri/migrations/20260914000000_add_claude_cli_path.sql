-- Store an optional explicit path to the Claude Code CLI executable.
-- NULL means "discover it automatically" (env override, well-known install
-- locations, then PATH). Only used by the 'claude-cli' summary provider.
ALTER TABLE settings ADD COLUMN claudeCliPath TEXT;
