# Big-bang greenfield rewrite with one-shot migration

The v1 server (Go + SQLite) and v1 client (Electron + SolidJS) have architectural ceilings that can't be fixed incrementally: whole-snapshot sync, no real accounts, no mobile story, offline-local-library complexity that permeates the client. We decided to rewrite both sides greenfield in a new monorepo, with a one-shot `migrate` subcommand that imports v1 server databases and uploads.

This was chosen over a strangler-pattern rewrite because the user base is 3 known users on 3 self-hosted servers the operator controls, so there is no user-facing continuity constraint that justifies carrying v1 in maintenance mode. The migration risk is absorbed by the operator running the script on each server directly.

The old repositories are archived once v2 is live. No v1 compatibility shim, no v1 maintenance branch, no parallel-run period.
