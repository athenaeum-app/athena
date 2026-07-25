package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/athenaeum-app/athena/server/internal/db"
	"golang.org/x/crypto/bcrypt"
)

// Self-service account changes: a signed-in user editing their own username or
// password. Administering *other* people's accounts is a separate concern
// (roles, in users.go) and deliberately does not live here. Nothing in this
// file takes an actor and a target, only the one user making the change.

const (
	// MinPasswordLength mirrors the client's registration form. Short, because
	// this is a personal library on a network the owner controls, not a public
	// service, but not absent, or "1" would be accepted.
	MinPasswordLength = 6

	// MaxUsernameLength keeps a username renderable in the places it appears
	// unabbreviated (chat author labels, the members roster).
	MaxUsernameLength = 32
)

var (
	ErrPasswordTooShort  = fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	ErrUsernameEmpty     = errors.New("username cannot be empty")
	ErrUsernameTooLong   = fmt.Errorf("username must be at most %d characters", MaxUsernameLength)
	ErrUsernameUnchanged = errors.New("that is already your username")
)

// VerifyPassword checks a password against the stored hash for a user. Every
// account change is gated on this, including a username change: a session
// cookie is enough to *use* the app, but taking over the account it belongs to
// should need the password itself.
func VerifyPassword(userID, password string) error {
	var hash string
	err := db.DB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if err == sql.ErrNoRows {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return ErrInvalidCredentials
	}
	return nil
}

// NormalizeUsername trims a submitted username and validates it. Returns the
// value to store.
func NormalizeUsername(username string) (string, error) {
	name := strings.TrimSpace(username)
	if name == "" {
		return "", ErrUsernameEmpty
	}
	// Count runes, not bytes, so a non-ASCII name isn't rejected for being
	// "too long" when it is nothing of the sort.
	if utf8.RuneCountInString(name) > MaxUsernameLength {
		return "", ErrUsernameTooLong
	}
	return name, nil
}

// ChangeUsername renames a user. The username is the login identifier, so it
// must stay unique; the check and the update run in one transaction so two
// simultaneous renames cannot both pass it.
func ChangeUsername(userID, username string) error {
	name, err := NormalizeUsername(username)
	if err != nil {
		return err
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var current string
	err = tx.QueryRow(`SELECT username FROM users WHERE id = ?`, userID).Scan(&current)
	if err == sql.ErrNoRows {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if current == name {
		return ErrUsernameUnchanged
	}

	var taken int64
	err = tx.QueryRow(`SELECT 1 FROM users WHERE username = ? AND id != ?`, name, userID).Scan(&taken)
	if err == nil {
		return ErrUsernameTaken
	} else if err != sql.ErrNoRows {
		return err
	}

	if _, err := tx.Exec(`UPDATE users SET username = ? WHERE id = ?`, name, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// ChangePassword replaces a user's password hash. The caller is responsible
// for having verified the current password first (see VerifyPassword).
func ChangePassword(userID, newPassword string) error {
	if utf8.RuneCountInString(newPassword) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcryptCost)
	if err != nil {
		return err
	}
	res, err := db.DB.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, string(hash), userID)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrUserNotFound
	}
	return nil
}

// RevokeOtherSessions deletes every session for a user except the one making
// the request, and returns how many it removed. Called after a password change
// so that changing it actually locks out whoever else was signed in, which is
// the reason most people change a password in the first place. The current
// session is kept so the user isn't logged out of the tab they just used.
func RevokeOtherSessions(userID, keepSessionID string) (int64, error) {
	res, err := db.DB.Exec(
		`DELETE FROM sessions WHERE user_id = ? AND id != ?`,
		userID, keepSessionID,
	)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, nil
}
