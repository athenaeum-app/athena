package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

// An uploaded file used to be handed back inline with a content type taken
// from the uploader's own filename, so `evil.svg` came back as an active
// document on the app's origin (issue #89). What may render in place is an
// allowlist now, and everything else downloads.

// upload posts one file and returns the created asset's id.
func upload(t *testing.T, e *testEnv, name, content string) string {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", name)
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	if _, err := io.WriteString(part, content); err != nil {
		t.Fatalf("write part: %v", err)
	}
	form.Close()

	req, err := http.NewRequest("POST", e.srv.URL+"/api/v1/assets", &body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := e.client.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload %s: status %d", name, resp.StatusCode)
	}

	var asset struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&asset); err != nil {
		t.Fatalf("decode asset: %v", err)
	}
	return asset.ID
}

// fetchAsset returns the response headers for an asset, without ?download.
func fetchAsset(t *testing.T, e *testEnv, id string) http.Header {
	t.Helper()
	resp, err := e.client.Get(e.srv.URL + "/api/v1/assets/" + id)
	if err != nil {
		t.Fatalf("get asset: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get asset: status %d", resp.StatusCode)
	}
	return resp.Header
}

func TestADocumentUploadIsHandedOverAsAFile(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	for _, file := range []struct{ name, body string }{
		{"payload.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`},
		{"payload.html", `<html><script>alert(1)</script></html>`},
	} {
		headers := fetchAsset(t, env, upload(t, env, file.name, file.body))
		if got := headers.Get("Content-Disposition"); !strings.HasPrefix(got, "attachment") {
			t.Errorf("%s was served inline: Content-Disposition %q", file.name, got)
		}
	}
}

// The counterweight: closing the hole must not turn the media the client
// renders into a row of download links.
func TestMediaTheClientDrawsIsStillServedInPlace(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// A one-pixel PNG, an mp4 by name, and a PDF, which is the one that has to
	// stay inline for the iframe preview to keep working.
	for _, name := range []string{"pixel.png", "clip.mp4", "paper.pdf"} {
		headers := fetchAsset(t, env, upload(t, env, name, "not really the format, only the name matters here"))
		if got := headers.Get("Content-Disposition"); got != "" {
			t.Errorf("%s was forced to download: Content-Disposition %q", name, got)
		}
	}
}

// Asking for it is still the way to get a download of anything.
func TestDownloadIsStillHonouredForInlineTypes(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	id := upload(t, env, "pixel.png", "x")
	resp, err := env.client.Get(env.srv.URL + "/api/v1/assets/" + id + "?download=1")
	if err != nil {
		t.Fatalf("get asset: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(got, "attachment") {
		t.Fatalf("?download=1 did not force a download: %q", got)
	}
}

// nosniff is the other half: without it a browser may decide for itself that a
// file is HTML whatever we said it was.
func TestEveryResponseRefusesContentSniffing(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	id := upload(t, env, "payload.svg", "<svg/>")
	for _, path := range []string{"/api/v1/health", "/api/v1/assets/" + id, "/api/v1/moments"} {
		resp, err := env.client.Get(env.srv.URL + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options is %q", path, got)
		}
		// SAMEORIGIN and not DENY: the client previews a PDF in an iframe
		// pointed at this same server.
		if got := resp.Header.Get("X-Frame-Options"); got != "SAMEORIGIN" {
			t.Errorf("%s: X-Frame-Options is %q", path, got)
		}
	}
}
