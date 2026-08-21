package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

// Guessing at a password used to be free (issue #88). bcrypt cost 12 was the
// only brake, and it is a brake on the server as much as on the attacker: an
// unauthenticated flood at this endpoint spends the box's CPU, not its own.
//
// The per-username budget is 10 in fifteen minutes, so a run of wrong guesses
// at one account stops being answered well before this loop ends.

// wrongPassword posts a bad login for username and returns the status.
func wrongPassword(t *testing.T, e *testEnv, username string) int {
	t.Helper()
	status, _ := e.do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": username,
		"password": "definitely-not-it",
	})
	return status
}

func TestLoginStopsAnsweringAFloodOfWrongGuesses(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	refusedAt := 0
	for i := 1; i <= 20; i++ {
		status := wrongPassword(t, env, "owner")
		if status == http.StatusTooManyRequests {
			refusedAt = i
			break
		}
		if status != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401 while inside the budget, got %d", i, status)
		}
	}

	if refusedAt == 0 {
		t.Fatal("twenty wrong passwords in a row and the server was still hashing them")
	}
	if refusedAt > 12 {
		t.Fatalf("refused only at attempt %d, looser than the stated budget", refusedAt)
	}
}

// A refusal has to say when to come back, or the only thing a caller can do
// with it is keep trying.
func TestARefusedLoginSaysWhenToComeBack(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	var refused *http.Response
	for i := 0; i < 20; i++ {
		body, _ := json.Marshal(map[string]any{"username": "owner", "password": "wrong"})
		req, err := http.NewRequest("POST", env.srv.URL+"/api/v1/auth/login", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := env.client.Do(req)
		if err != nil {
			t.Fatalf("login: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			refused = resp
			break
		}
	}
	if refused == nil {
		t.Fatal("never refused")
	}

	after := refused.Header.Get("Retry-After")
	if after == "" {
		t.Fatal("refused without a Retry-After header")
	}
	seconds, err := strconv.Atoi(after)
	if err != nil || seconds <= 0 {
		t.Fatalf("Retry-After is not a positive number of seconds: %q", after)
	}
}

// Someone who mistypes and then gets it right is not what the counter is for,
// and should not carry the count into their next session.
func TestASuccessfulLoginClearsTheCount(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	for i := 0; i < 8; i++ {
		wrongPassword(t, env, "owner")
	}
	status, _ := env.do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "owner",
		"password": "password123",
	})
	if status != http.StatusOK {
		t.Fatalf("the right password inside the budget was refused: %d", status)
	}

	// The eight wrong guesses are forgotten, so a fresh run of them is inside
	// the budget again rather than tipping straight over it.
	for i := 0; i < 8; i++ {
		if got := wrongPassword(t, env, "owner"); got == http.StatusTooManyRequests {
			t.Fatalf("attempt %d after a success was refused: the count was not cleared", i+1)
		}
	}
}

// One account being hammered must not lock out the rest of the library, which
// is the failure mode of counting only by address.
func TestGuessingAtOneAccountDoesNotLockOutAnother(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)
	second := env.invite(t, "second")

	for i := 0; i < 15; i++ {
		wrongPassword(t, env, "owner")
	}

	status, _ := second.do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "second",
		"password": "password123",
	})
	if status != http.StatusOK {
		t.Fatalf("a different account was refused because of guesses at the first: %d", status)
	}
}
