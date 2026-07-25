package web

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var webFS embed.FS

// FS returns the embedded client filesystem rooted at the web/ directory.
func FS() fs.FS {
	sub, _ := fs.Sub(webFS, "web")
	return sub
}
