// Package domain contains pure data-access operations against the SQLite
// database. It performs no permission checks and writes no sync events;
// the API layer is responsible for both. Each function operates on the
// shared db.DB connection.
package domain

import "github.com/athenaeum-app/athena/server/internal/config"

// Config holds the loaded server configuration. It must be set by the
// application at startup (typically right after config.Load) before any
// function that consults it (currently only GetLinkPreview's TTL check)
// is called.
var Config *config.Config
