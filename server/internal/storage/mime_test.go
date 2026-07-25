package storage

import "testing"

// The point of MimeTypeForName is that it does NOT depend on the host's mime
// database, because production is an alpine image that has none. These cases
// are the ones the platform table gets wrong or misses entirely. They would
// pass on a developer machine either way, and fail in the container if the
// declared table were removed.
func TestMimeTypeForName(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		// Absent from Go's built-in table: octet-stream without ours, which
		// the client renders as a download chip instead of a player. .mov is
		// the one that matters most, since it is what phones record.
		{"clip.mov", "video/quicktime"},
		{"episode.mkv", "video/x-matroska"},
		{"old-camera.avi", "video/x-msvideo"},
		{"holiday.m4v", "video/x-m4v"},
		{"phone.3gp", "video/3gpp"},

		// Present in the built-in table, but as audio/webm, so a video would
		// render in an <audio> element and lose its picture.
		{"screencast.webm", "video/webm"},

		// Already correct upstream; pinned so a refactor cannot regress them.
		{"clip.mp4", "video/mp4"},
		{"song.mp3", "audio/mpeg"},
		{"voice.m4a", "audio/mp4"},

		// Case and path handling.
		{"SHOUTING.MOV", "video/quicktime"},
		{"/some/dir/nested.mov", "video/quicktime"},

		// An unknown type is reported as unknown rather than guessed at.
		{"archive.zzz", "application/octet-stream"},
		{"no-extension", "application/octet-stream"},
	}

	for _, tc := range cases {
		if got := MimeTypeForName(tc.name); got != tc.want {
			t.Errorf("MimeTypeForName(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// Images still resolve through the platform table, which covers them well.
func TestMimeTypeForNameKeepsImages(t *testing.T) {
	for name, want := range map[string]string{
		"photo.png":  "image/png",
		"photo.jpg":  "image/jpeg",
		"photo.gif":  "image/gif",
		"photo.webp": "image/webp",
	} {
		if got := MimeTypeForName(name); got != want {
			t.Errorf("MimeTypeForName(%q) = %q, want %q", name, got, want)
		}
	}
}
