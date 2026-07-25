package storage

import (
	"mime"
	"path/filepath"
	"strings"
)

// MIME resolution for stored files.
//
// Go's mime package carries a small built-in table and, on unix, augments it
// from /etc/mime.types and friends. The runtime image is alpine with only
// ca-certificates and tzdata (see server/Dockerfile), so none of those files
// exist and the built-in table is all there is, and its coverage of media is
// patchy in exactly the places that matter:
//
//   - .mov, .mkv, .avi, .m4v, .3gp are absent, so they resolve to
//     application/octet-stream, and the client renders "some file you can
//     download" rather than a player.
//   - .webm maps to audio/webm, so a video renders in an <audio> element.
//     The sound plays and the picture is simply missing.
//
// Deferring to the host for this means the same upload is a video on a
// developer's machine and an unplayable blob in production. The types the app
// actually renders differently are declared here instead.
var mediaTypes = map[string]string{
	// Video. .webm is deliberately video rather than the built-in table's
	// audio: audio-only webm exists but is rare, and a <video> element plays
	// it correctly anyway, whereas <audio> cannot show a picture.
	".mp4":  "video/mp4",
	".m4v":  "video/x-m4v",
	".mov":  "video/quicktime",
	".mkv":  "video/x-matroska",
	".avi":  "video/x-msvideo",
	".webm": "video/webm",
	".ogv":  "video/ogg",
	".3gp":  "video/3gpp",
	".mpg":  "video/mpeg",
	".mpeg": "video/mpeg",

	// Audio.
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".wav":  "audio/wav",
	".flac": "audio/flac",
	".oga":  "audio/ogg",
	".opus": "audio/ogg",
}

// MimeTypeForName resolves a MIME type from a file's name, preferring the
// declared media types above and falling back to the platform table. Returns
// application/octet-stream when nothing matches, which is the honest answer
// for an unknown file rather than a guess.
func MimeTypeForName(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if t, ok := mediaTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}
