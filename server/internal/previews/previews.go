// Package previews scrapes OpenGraph and meta tags from URLs for link
// preview cards. It includes SSRF protection: private IP ranges and
// non-http(s) schemes are rejected.
package previews

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/models"
	"golang.org/x/net/html"
)

var client = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return checkSSRF(req.URL)
	},
}

// Scrape fetches the given URL and extracts OG/meta tags for a link preview.
func Scrape(rawURL string) (*models.LinkPreview, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if err := checkSSRF(parsed); err != nil {
		return nil, err
	}

	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "AthenaPreviewBot/1.0 (+https://github.com/athenaeum-app/athena)")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch failed: %s", resp.Status)
	}

	// Limit response size to 1MB to avoid reading huge pages
	body := io.LimitReader(resp.Body, 1<<20)

	doc, err := html.Parse(body)
	if err != nil {
		return nil, fmt.Errorf("parse HTML: %w", err)
	}

	preview := &models.LinkPreview{
		URL:       rawURL,
		ScrapedAt: time.Now(),
	}

	extractMeta(doc, preview)

	return preview, nil
}

func extractMeta(doc *html.Node, preview *models.LinkPreview) {
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "meta" {
			var prop, content string
			for _, attr := range n.Attr {
				switch attr.Key {
				case "property", "name":
					prop = attr.Val
				case "content":
					content = attr.Val
				}
			}
			switch strings.ToLower(prop) {
			case "og:title", "twitter:title":
				if preview.Title == "" {
					preview.Title = content
				}
			case "og:description", "twitter:description", "description":
				if preview.Description == "" {
					preview.Description = content
				}
			case "og:image", "twitter:image":
				if preview.ImageURL == "" {
					preview.ImageURL = content
				}
			}
		}
		if n.Type == html.ElementNode && n.Data == "title" && n.FirstChild != nil {
			if preview.Title == "" {
				preview.Title = n.FirstChild.Data
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
}

// checkSSRF validates that a URL is safe to fetch: http/https only,
// and not pointing at a private IP range.
func checkSSRF(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}

	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("empty host")
	}

	// Resolve and check IP
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("DNS lookup failed: %w", err)
	}

	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() {
			return fmt.Errorf("blocked: private/loopback IP %s", ip)
		}
	}

	return nil
}
