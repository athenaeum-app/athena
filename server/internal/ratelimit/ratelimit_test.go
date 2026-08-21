package ratelimit

import (
	"sync"
	"testing"
	"time"
)

// spend is what a caller does with a failed attempt: check, then charge.
func spend(l *Limiter, key string) bool {
	ok, _ := l.Allowed(key)
	if !ok {
		return false
	}
	l.Record(key)
	return true
}

func TestAllowsUpToTheLimitThenRefuses(t *testing.T) {
	l := New(3, time.Minute)

	for i := 1; i <= 3; i++ {
		if !spend(l, "k") {
			t.Fatalf("attempt %d was refused, limit is 3", i)
		}
	}
	ok, retry := l.Allowed("k")
	if ok {
		t.Fatal("the fourth attempt was allowed")
	}
	if retry <= 0 || retry > time.Minute {
		t.Fatalf("retryAfter %v is not inside the window", retry)
	}
}

// Checking is free. Only a failure charged with Record moves the count, which
// is what keeps an afternoon of successful logins from looking like an attack.
func TestCheckingDoesNotSpend(t *testing.T) {
	l := New(1, time.Minute)

	for i := 0; i < 50; i++ {
		if ok, _ := l.Allowed("k"); !ok {
			t.Fatalf("check %d was refused without anything being recorded", i)
		}
	}
}

func TestKeysAreCountedApart(t *testing.T) {
	l := New(1, time.Minute)

	spend(l, "one")
	if spend(l, "one") {
		t.Fatal("the second attempt on one key was allowed")
	}
	// A different key has its own budget: one person guessing at an account
	// must not lock out everyone else.
	if !spend(l, "two") {
		t.Fatal("a different key was refused")
	}
}

func TestTheWindowExpires(t *testing.T) {
	l := New(1, 20*time.Millisecond)

	spend(l, "k")
	if spend(l, "k") {
		t.Fatal("refused attempt was allowed inside the window")
	}
	time.Sleep(30 * time.Millisecond)
	if !spend(l, "k") {
		t.Fatal("still refused after the window passed")
	}
}

func TestResetClearsAKey(t *testing.T) {
	l := New(2, time.Minute)

	spend(l, "k")
	spend(l, "k")
	// Two wrong guesses then the right one: the count should not follow them
	// into the next session.
	l.Reset("k")
	if !spend(l, "k") {
		t.Fatal("a reset key was still being counted")
	}
}

func TestExpiredKeysAreNotKeptForever(t *testing.T) {
	l := New(1, 10*time.Millisecond)

	for i := 0; i < 100; i++ {
		spend(l, string(rune('a'+i%26)))
	}
	time.Sleep(20 * time.Millisecond)
	// The sweep runs at most once per window, so one call after it has passed
	// is what collects the dead keys.
	l.Allowed("trigger")

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.seen) > 2 {
		t.Fatalf("expired keys are still held: %d", len(l.seen))
	}
}

func TestConcurrentCallersAreCountedOnce(t *testing.T) {
	l := New(1000, time.Minute)

	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.Record("k")
		}()
	}
	wg.Wait()

	l.mu.Lock()
	defer l.mu.Unlock()
	if got := l.seen["k"].count; got != 200 {
		t.Fatalf("200 concurrent records should count 200, got %d", got)
	}
}
