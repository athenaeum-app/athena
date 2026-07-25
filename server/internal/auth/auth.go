// Package auth implements registration, login, sessions, and permission
// resolution for the athenaeum server.
//
// Design notes:
//
//   - The first user to register on an empty users table becomes the Owner.
//     No invite is required in that case; the Owner role is created on the
//     fly and assigned to them. All subsequent registrations require a valid
//     invite (ADR-0005).
//   - Sessions are opaque random IDs stored server-side (ADR-0008). The raw
//     ID lives in the httpOnly cookie and in the sessions table.
//   - A user's effective permissions are the bitwise OR of every role they
//     hold, plus the default role's permissions (ADR-0009).
package auth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

const (
	// SessionCookieName is the name of the httpOnly cookie holding the
	// session ID.
	SessionCookieName = "athenaeum_session"

	// OwnerRoleID is the stable identifier for the Owner role. Unlike
	// custom roles (which get UUIDs), the Owner role uses a fixed ID so it
	// can be referenced deterministically and protected from edits.
	OwnerRoleID = "role_owner"

	// DefaultRoleID is the stable identifier for the role every user is
	// assigned on registration, and whose permissions therefore act as the
	// floor for the whole library. Member held this job until migration 0008
	// retired it in favour of Viewer, so that arriving through an invite
	// grants the ability to read the library and nothing else.
	DefaultRoleID = "role_viewer"

	bcryptCost = 12
)

// Sentinel errors. Callers may test against these with errors.Is.
var (
	ErrInvalidCredentials  = errors.New("invalid credentials")
	ErrInviteRequired      = errors.New("an invite is required to register")
	ErrInviteInvalid       = errors.New("invite is invalid or expired")
	ErrInviteExhausted     = errors.New("invite has no uses remaining")
	ErrSessionNotFound     = errors.New("session not found")
	ErrSessionExpired      = errors.New("session has expired")
	ErrUserNotFound        = errors.New("user not found")
	ErrUsernameTaken       = errors.New("username already taken")
	ErrRoleNotFound        = errors.New("role not found")
	ErrOwnerRoleProtected  = errors.New("the owner role cannot be modified or removed")
	ErrPresetRoleProtected = errors.New("preset roles cannot be deleted")
)

// appConfig holds the loaded server configuration, used by Login to compute
// session expiry. Set it once at startup via SetConfig.
var appConfig *config.Config

// SetConfig stores the server configuration for use by Login. Call this
// once during startup, after config.Load and before serving requests.
func SetConfig(c *config.Config) {
	appConfig = c
}

// Register creates a new user. If the users table is empty, the new user
// becomes the Owner (the inviteID is ignored and an Owner role is created
// for them). Otherwise a valid, non-exhausted, unexpired invite is required;
// the invite is consumed (and deleted if that spent its last use) and the
// user is assigned the default role.
func Register(username, password string, inviteID *string) (*models.User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return nil, err
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Reject duplicate usernames before the insert so we can return a
	// typed error rather than relying on driver-specific constraint codes.
	var dummy int64
	if err := tx.QueryRow(`SELECT 1 FROM users WHERE username = ?`, username).Scan(&dummy); err == nil {
		return nil, ErrUsernameTaken
	} else if err != sql.ErrNoRows {
		return nil, err
	}

	var userCount int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil {
		return nil, err
	}

	user := &models.User{
		ID:           uuid.NewString(),
		Username:     username,
		PasswordHash: string(hash),
		CreatedAt:    time.Now(),
	}

	if userCount == 0 {
		// First-user-becomes-owner flow (ADR-0005).
		user.IsOwner = true
		if _, err := tx.Exec(
			`INSERT INTO users (id, username, password_hash, is_owner) VALUES (?, ?, ?, 1)`,
			user.ID, user.Username, user.PasswordHash,
		); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(
			`INSERT INTO roles (id, name, color, position, is_preset, is_default, permissions) VALUES (?, ?, ?, ?, 1, 0, ?)`,
			OwnerRoleID, "Owner", "#f1c40f", 4, uint32(permissions.OwnerPerms),
		); err != nil {
			return nil, err
		}
		// The owner also holds the Member default role.
		if _, err := tx.Exec(
			`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?), (?, ?)`,
			user.ID, OwnerRoleID, user.ID, DefaultRoleID,
		); err != nil {
			return nil, err
		}
	} else {
		if inviteID == nil || *inviteID == "" {
			return nil, ErrInviteRequired
		}
		if err := validateInviteTx(tx, *inviteID); err != nil {
			return nil, err
		}
		user.IsOwner = false
		if _, err := tx.Exec(
			`INSERT INTO users (id, username, password_hash, is_owner) VALUES (?, ?, ?, 0)`,
			user.ID, user.Username, user.PasswordHash,
		); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(
			`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
			user.ID, DefaultRoleID,
		); err != nil {
			return nil, err
		}
		// Consume within the same transaction for atomicity. Already
		// validated above, so this is the write half only; it deletes the
		// invite outright if this registration spent its last use.
		if err := consumeInviteTx(tx, *inviteID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return user, nil
}

// Login verifies the username/password pair and creates a new session.
//
// When stayLoggedIn is false and SessionExpiryDays > 0, the session gets a
// sliding expiry of SessionExpiryDays from now. When stayLoggedIn is true
// (or SessionExpiryDays is 0, meaning "no expiry"), the session never
// expires (ADR-0008).
func Login(username, password string, stayLoggedIn bool, ip, userAgent string) (*models.Session, error) {
	user, err := scanUser(db.DB.QueryRow(
		`SELECT id, username, password_hash, email, is_owner, created_at FROM users WHERE username = ?`,
		username,
	))
	if err == sql.ErrNoRows {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, ErrInvalidCredentials
	}

	sessionID, err := newSessionID()
	if err != nil {
		return nil, err
	}

	var expiresAt *time.Time
	if !stayLoggedIn && appConfig != nil && appConfig.SessionExpiryDays > 0 {
		sessionExpiry := time.Now().AddDate(0, 0, appConfig.SessionExpiryDays)
		expiresAt = &sessionExpiry
	}

	session := &models.Session{
		ID:        sessionID,
		UserID:    user.ID,
		ExpiresAt: expiresAt,
		IP:        ip,
		UserAgent: userAgent,
		CreatedAt: time.Now(),
	}

	if expiresAt != nil {
		_, err = db.DB.Exec(
			`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
			session.ID, session.UserID, session.ExpiresAt, session.IP, session.UserAgent,
		)
	} else {
		_, err = db.DB.Exec(
			`INSERT INTO sessions (id, user_id, ip, user_agent) VALUES (?, ?, ?, ?)`,
			session.ID, session.UserID, session.IP, session.UserAgent,
		)
	}
	if err != nil {
		return nil, err
	}
	return session, nil
}

// Logout deletes the server-side session row. It is safe to call with an
// already-expired or unknown session ID.
func Logout(sessionID string) error {
	_, err := db.DB.Exec(`DELETE FROM sessions WHERE id = ?`, sessionID)
	return err
}

// GetSession looks up a session by ID and returns it if it is still valid.
// A nil expiry means the session never expires.
func GetSession(sessionID string) (*models.Session, error) {
	s, err := scanSession(db.DB.QueryRow(
		`SELECT id, user_id, expires_at, ip, user_agent, created_at FROM sessions WHERE id = ?`,
		sessionID,
	))
	if err == sql.ErrNoRows {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	if s.ExpiresAt != nil && s.ExpiresAt.Before(time.Now()) {
		return nil, ErrSessionExpired
	}
	return s, nil
}

// GetUser fetches a single user by ID.
func GetUser(userID string) (*models.User, error) {
	user, err := scanUser(db.DB.QueryRow(
		`SELECT id, username, password_hash, email, is_owner, created_at FROM users WHERE id = ?`,
		userID,
	))
	if err == sql.ErrNoRows {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return user, nil
}

// GetUserPermissions returns the effective permission bitmask for a user:
// the bitwise OR of all their roles' permissions, plus the default role's
// permissions (which every user is entitled to, even if the user_roles row
// is somehow missing).
//
// The OR is done here in Go rather than in SQL. SQLite has no bitwise-or
// aggregate, and the obvious stand-in, SUM(), is wrong: whenever two of a
// user's roles set the same bit, the addition carries into the next bit and
// silently corrupts every flag above it. That is not a theoretical edge case,
// it is the common one, because every user also holds the default role: the
// owner (Owner + Member) had the carry from their overlapping low bits ripple
// all the way up and clear ADMINISTRATOR and MANAGE_ROLES, so the owner was
// locked out of administering their own server.
//
// The two SELECTs are UNIONed into one query on purpose: the connection pool
// is capped at a single connection (see db.Open), so iterating one result set
// while opening another would deadlock.
func GetUserPermissions(userID string) (permissions.Flag, error) {
	rows, err := db.DB.Query(
		`SELECT r.permissions
		   FROM user_roles ur
		   JOIN roles r ON r.id = ur.role_id
		  WHERE ur.user_id = ?
		 UNION ALL
		 SELECT permissions FROM roles WHERE is_default = 1`,
		userID,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var perms permissions.Flag
	for rows.Next() {
		var p int64
		if err := rows.Scan(&p); err != nil {
			return 0, err
		}
		perms |= permissions.Flag(uint32(p))
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	return perms, nil
}

// newSessionID returns a 32-byte cryptographically random hex-encoded ID.
func newSessionID() (string, error) {
	randomBytes := make([]byte, 32)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(randomBytes), nil
}

// scanUser populates a User from a single-row query. Both *sql.DB and
// *sql.Tx produce *sql.Row, so this works for both ad-hoc and transactional
// lookups.
func scanUser(row *sql.Row) (*models.User, error) {
	var u models.User
	var email sql.NullString
	var isOwner int64
	if err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &email, &isOwner, &u.CreatedAt); err != nil {
		return nil, err
	}
	u.IsOwner = isOwner != 0
	if email.Valid {
		u.Email = &email.String
	}
	return &u, nil
}

// scanSession populates a Session from a single-row query.
func scanSession(row *sql.Row) (*models.Session, error) {
	var s models.Session
	var expiresAt sql.NullTime
	if err := row.Scan(&s.ID, &s.UserID, &expiresAt, &s.IP, &s.UserAgent, &s.CreatedAt); err != nil {
		return nil, err
	}
	if expiresAt.Valid {
		s.ExpiresAt = &expiresAt.Time
	}
	return &s, nil
}
