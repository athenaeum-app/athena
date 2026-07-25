// Package presence tracks which users have made an authenticated request
// recently, purely to drive the "online" dot on the Members roster. It is
// intentionally process-local, in-memory, and coarse: it is not a durable
// record, doesn't need to survive a restart, and doesn't need to be exact.
// It just needs to answer "did we hear from this user in roughly the last
// poll cycle or two."
package presence

import (
	"sync"
	"time"
)

// onlineWindow is how recently a user must have made a request to count as
// online. Comfortably above the client's event-poll interval (3s) so a
// session reads as online between polls without flapping.
const onlineWindow = 45 * time.Second

var (
	mu       sync.RWMutex
	lastSeen = map[string]time.Time{}
)

// Touch records that userID made an authenticated request just now. Called
// from the auth middleware, so presence is a side effect of normal API
// traffic rather than a separate heartbeat endpoint.
func Touch(userID string) {
	mu.Lock()
	lastSeen[userID] = time.Now()
	mu.Unlock()
}

// IsOnline reports whether userID has been seen within onlineWindow.
func IsOnline(userID string) bool {
	mu.RLock()
	t, ok := lastSeen[userID]
	mu.RUnlock()
	return ok && time.Since(t) < onlineWindow
}
