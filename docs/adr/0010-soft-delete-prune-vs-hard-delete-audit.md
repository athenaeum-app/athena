# Soft delete with auto-prune for moments and chat; hard delete with audit log for everything else

Moments and chat messages use soft delete (`deleted_at` timestamp) with auto-prune: a background job permanently deletes rows where `deleted_at < now - N days` (default 365, configurable). A manual prune button is available to admins. Archives, tags, and assets use hard delete, with the audit log retaining enough of the pre-delete state to reconstruct if needed.

This was chosen over uniform soft deletes because soft-delete flags require `WHERE deleted_at IS NULL` on every query, which is easy to forget and was applied inconsistently in v1 (the chat path used soft delete, the action path used hard delete). Structural entities (archives, tags) cascade on delete, and soft-deleting a tree is messy. Assets are file-backed and soft-deleting files on disk is awkward.

The audit log (for accountability) and the event stream (for sync) are separate tables with separate retention. The event stream is compact and pruned aggressively (90 days); the audit log is detailed and retained longer (365 days). They overlap in content but serve different purposes and should not be merged.
