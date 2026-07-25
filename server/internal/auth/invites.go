package auth

import (
	"database/sql"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

// CreateInvite inserts a new invite. The caller is responsible for verifying
// that createdBy holds permissions.ManageUsers; this function only records
// the creator for the foreign key and audit trail.
//
// The uses_remaining column is a sentinel-encoded counter:
//
//	-1 = unlimited uses (never decremented, never exhausted)
//	 0 = exhausted (no uses remaining)
//	>0 = finite number of uses remaining
//
// A uses argument of 0 or less means "unlimited" and is stored as -1. This
// keeps a finite invite that decrements down to 0 distinguishable from an
// unlimited one; without the sentinel, a spent single-use invite (0) would
// be indistinguishable from unlimited and thus reusable forever.
func CreateInvite(createdBy string, uses int, expiresAt *time.Time) (*models.Invite, error) {
	if uses <= 0 {
		uses = -1 // unlimited
	}
	invite := &models.Invite{
		ID:            uuid.NewString(),
		CreatedBy:     createdBy,
		UsesRemaining: uses,
		ExpiresAt:     expiresAt,
		CreatedAt:     time.Now(),
	}

	if expiresAt != nil {
		_, err := db.DB.Exec(
			`INSERT INTO invites (id, created_by, uses_remaining, expires_at) VALUES (?, ?, ?, ?)`,
			invite.ID, invite.CreatedBy, invite.UsesRemaining, invite.ExpiresAt,
		)
		if err != nil {
			return nil, err
		}
	} else {
		_, err := db.DB.Exec(
			`INSERT INTO invites (id, created_by, uses_remaining) VALUES (?, ?, ?)`,
			invite.ID, invite.CreatedBy, invite.UsesRemaining,
		)
		if err != nil {
			return nil, err
		}
	}
	return invite, nil
}

// ValidateInvite returns nil if the invite exists, has uses remaining (or
// unlimited uses), and has not expired. Otherwise it returns a typed error.
func ValidateInvite(inviteID string) error {
	return validateInviteTx(db.DB, inviteID)
}

// validateInviteTx is the transaction-aware core of ValidateInvite. It
// accepts either *sql.DB or *sql.Tx (both implement the query methods we
// need via the sqlx-like interface{} trick below).
func validateInviteTx(q queryer, inviteID string) error {
	var usesRemaining int64
	var expiresAt sql.NullTime
	err := q.QueryRow(
		`SELECT uses_remaining, expires_at FROM invites WHERE id = ?`,
		inviteID,
	).Scan(&usesRemaining, &expiresAt)
	if err == sql.ErrNoRows {
		return ErrInviteInvalid
	}
	if err != nil {
		return err
	}
	// uses_remaining == -1 means unlimited; >0 is finite with uses left;
	// 0 means the invite has been fully consumed.
	if usesRemaining == 0 {
		return ErrInviteExhausted
	}
	if expiresAt.Valid && expiresAt.Time.Before(time.Now()) {
		return ErrInviteInvalid
	}
	return nil
}

// ConsumeInvite spends one use of an invite, deleting it once its last use is
// gone. Callers must not rely on the invite existing afterwards. Register
// consumes inside its own transaction; this standalone form is exposed for
// admin tooling.
func ConsumeInvite(inviteID string) error {
	if err := ValidateInvite(inviteID); err != nil {
		return err
	}
	return consumeInviteTx(db.DB, inviteID)
}

// consumeInviteTx decrements a finite invite's remaining uses and deletes the
// row once that reaches zero. Unlimited invites (-1) fail the
// `uses_remaining > 0` guard, so they are neither decremented nor deleted.
//
// Deleting on exhaustion is what makes a spent link disappear from the admin
// list rather than sitting there at "0 use(s) left" waiting to be cleaned up
// by hand. Nothing is lost by dropping the row: who joined through an invite
// is recorded in the audit log, not here.
//
// The caller is responsible for validating first; this is the write half only.
func consumeInviteTx(q execer, inviteID string) error {
	if _, err := q.Exec(
		`UPDATE invites SET uses_remaining = uses_remaining - 1 WHERE id = ? AND uses_remaining > 0`,
		inviteID,
	); err != nil {
		return err
	}
	_, err := q.Exec(`DELETE FROM invites WHERE id = ? AND uses_remaining = 0`, inviteID)
	return err
}

// ListInvites returns all invites, newest first.
func ListInvites() ([]models.Invite, error) {
	rows, err := db.DB.Query(
		`SELECT id, created_by, uses_remaining, expires_at, created_at FROM invites ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	invites := []models.Invite{}
	for rows.Next() {
		var inv models.Invite
		var expiresAt sql.NullTime
		if err := rows.Scan(&inv.ID, &inv.CreatedBy, &inv.UsesRemaining, &expiresAt, &inv.CreatedAt); err != nil {
			return nil, err
		}
		if expiresAt.Valid {
			inv.ExpiresAt = &expiresAt.Time
		}
		invites = append(invites, inv)
	}
	return invites, rows.Err()
}

// RevokeInvite deletes an invite. It is idempotent: revoking an already-
// deleted or unknown invite returns nil.
func RevokeInvite(inviteID string) error {
	_, err := db.DB.Exec(`DELETE FROM invites WHERE id = ?`, inviteID)
	return err
}

// queryer is the minimal subset of *sql.DB / *sql.Tx that validateInviteTx
// needs. Both types satisfy it implicitly.
type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

// execer is the same idea for consumeInviteTx, which only writes.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// guard: ensure *sql.Tx satisfies both at compile time.
var (
	_ queryer = (*sql.Tx)(nil)
	_ execer  = (*sql.Tx)(nil)
)
