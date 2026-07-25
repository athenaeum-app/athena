package config

import (
	"testing"
	"time"
)

// PREVIEW_CACHE_TTL_HOURS is named in hours and documented in hours, but was
// read with time.ParseDuration, which rejects a value carrying no unit. A host
// setting the documented "24" got the 168h fallback instead, silently. These
// cases pin both spellings.
func TestPreviewCacheTTLAcceptsHoursAndDurations(t *testing.T) {
	const fallback = 168 * time.Hour

	cases := []struct {
		name  string
		value string
		want  time.Duration
	}{
		{"bare number is read as hours", "24", 24 * time.Hour},
		{"the documented default", "168", 168 * time.Hour},
		{"a duration string still works", "24h", 24 * time.Hour},
		{"sub-hour durations are honoured", "90m", 90 * time.Minute},
		{"unset falls back", "", fallback},
		{"nonsense falls back", "soon", fallback},
		{"zero falls back rather than disabling the cache", "0", fallback},
		{"negative falls back", "-5", fallback},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("PREVIEW_CACHE_TTL_HOURS", testCase.value)
			got := envHoursOr("PREVIEW_CACHE_TTL_HOURS", fallback)
			if got != testCase.want {
				t.Errorf("value %q: got %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}
}
