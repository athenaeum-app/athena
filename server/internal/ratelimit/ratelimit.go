// Package ratelimit is a fixed-window counter for the handful of endpoints
// that do expensive work before they have any reason to trust the caller.
//
// In process and in memory on purpose. Athena is one process with a SQLite
// file beside it, so a shared store would be a dependency bought for nothing:
// there is no second replica for a counter to disagree with.
//
// A fixed window rather than a token bucket or a sliding log. It is a few
// lines, it needs one timestamp per key, and the thing it gives up (a caller
// can spend a full window's budget at the end of one window and again at the
// start of the next) does not matter for what this guards. Bounding password
// guesses to twice a limit per window instead of once is not the difference
// between safe and unsafe.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter allows `limit` events per `window` for each key it is asked about.
type Limiter struct {
	limit  int
	window time.Duration

	mu   sync.Mutex
	seen map[string]*entry
	// Keys are never revisited once their window has passed, so the map would
	// otherwise grow forever on a server anyone can send a new username to.
	// Cleaned opportunistically rather than by a goroutine: this is called on
	// a request path that is already rate limited, so the sweep is bounded by
	// the same limit that bounds everything else here.
	lastSweep time.Time
}

type entry struct {
	count   int
	resetAt time.Time
}

func New(limit int, window time.Duration) *Limiter {
	return &Limiter{limit: limit, window: window, seen: map[string]*entry{}}
}

// Allowed reports whether key still has budget, without spending any. The
// retry duration is how long until the key's window resets, and is only
// meaningful when allowed is false.
//
// Split from Record on purpose. What these limiters guard is the work done for
// callers who turn out to be nobody, so it is failures that should cost, not
// attempts: a caller who keeps succeeding is not the thing being counted, and
// charging them would make an ordinary busy afternoon indistinguishable from
// an attack.
func (l *Limiter) Allowed(key string) (allowed bool, retryAfter time.Duration) {
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)

	found, ok := l.seen[key]
	if !ok || now.After(found.resetAt) {
		return true, 0
	}
	if found.count >= l.limit {
		return false, found.resetAt.Sub(now)
	}
	return true, 0
}

// Record spends one of key's budget.
func (l *Limiter) Record(key string) {
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	found, ok := l.seen[key]
	if !ok || now.After(found.resetAt) {
		l.seen[key] = &entry{count: 1, resetAt: now.Add(l.window)}
		return
	}
	found.count++
}

// Reset forgets a key. Called when an attempt succeeds: someone who mistyped
// twice and then got it right has proved they are not the thing this is here
// to stop, and should not carry the count into their next session.
//
// Only ever called on the key for the account that succeeded. Resetting the
// address key on success would hand back a bypass: fail to the limit, log in
// once with an account you do hold, and start again.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.seen, key)
}

// sweep drops expired entries. Caller holds the lock.
func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < l.window {
		return
	}
	l.lastSweep = now
	for key, found := range l.seen {
		if now.After(found.resetAt) {
			delete(l.seen, key)
		}
	}
}
