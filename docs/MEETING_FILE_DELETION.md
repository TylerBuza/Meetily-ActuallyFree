# Meeting file deletion

The default removal keeps local files. The explicit delete-files choice passes
only a meeting ID to `api_delete_meeting`; its folder comes from SQLite.
`api/meeting_deletion.rs` resolves the folder and every other meeting reference
using native canonical identities, including existing symlinks/junctions and
missing descendants. It refuses any recording root, outside path, shared alias,
ancestor or descendant of another meeting. Unresolvable references fail closed.

The folder read, other references and related-row deletion share one SQLite
transaction. Database failure preserves the folder. After commit, a single
cleanup operation runs with `spawn_blocking`; filesystem failure returns
success for the database removal plus a warning with the folder path. The UI
refreshes the library, shows that warning and never claims all files were deleted.
This ordering avoids a surviving database meeting whose files were deleted by a
failed database operation. It does not roll back completed database removal when
cleanup fails; recursive cleanup can leave partial files for manual recovery.

Native temporary-directory/in-memory SQLite tests cover dot/parent aliases,
Windows case aliases and junctions, parent/child ownership, recording roots,
outside paths, missing folders, database constraints, cleanup failure and success.
Unix symlink coverage is platform-specific and was not run on Windows. Frontend
`tests/lib/meeting-deletion.test.ts` checks partial-cleanup and refusal messages.
No private recordings are used or deleted in these tests.

The selected folder's contents are explicitly included in the user's deletion
choice; unregistered files within it are not individually inventoried. This is
not an operating-system filesystem lock: external processes must not replace or
reassign the folder during cleanup. A crash after database commit can retain an
orphan recording folder; no durable cleanup journal is claimed.
