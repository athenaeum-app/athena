package auth

import (
	"database/sql"
	"fmt"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/presence"
)

// ListUsers returns all users, ordered by username. Used by the admin
// user management UI.
func ListUsers() ([]models.User, error) {
	rows, err := db.DB.Query(
		`SELECT id, username, password_hash, email, is_owner, created_at FROM users ORDER BY username`,
	)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	users := []models.User{}
	for rows.Next() {
		user, err := scanUserRow(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, *user)
	}
	return users, nil
}

// ListUserDirectory returns every user as a minimal public record (id +
// username), ordered by username. Any authenticated member may read this to
// resolve author IDs to usernames; it deliberately omits password hashes,
// emails, and session data. The users table has no display_name column, so
// only id and username are returned.
func ListUserDirectory() ([]models.PublicUser, error) {
	rows, err := db.DB.Query(`SELECT id, username FROM users ORDER BY username`)
	if err != nil {
		return nil, fmt.Errorf("list user directory: %w", err)
	}
	defer rows.Close()

	users := []models.PublicUser{}
	for rows.Next() {
		var u models.PublicUser
		if err := rows.Scan(&u.ID, &u.Username); err != nil {
			return nil, fmt.Errorf("scan public user: %w", err)
		}
		u.Online = presence.IsOnline(u.ID)
		users = append(users, u)
	}
	return users, rows.Err()
}

// UserCount returns the total number of registered users. Used by the setup
// endpoint to tell the client whether the server needs initial owner
// registration (ADR-0005: first-user-becomes-owner).
func UserCount() (int64, error) {
	var count int64
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count users: %w", err)
	}
	return count, nil
}

// SetUserRoles replaces the full set of roles for a user. The default role is
// always included automatically. The Owner role cannot be removed from the
// owner.
func SetUserRoles(userID string, roleIDs []string) error {
	// Check the user exists and whether they're the owner
	user, err := GetUser(userID)
	if err != nil {
		return fmt.Errorf("user not found: %w", err)
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Delete all existing role assignments
	if _, err := tx.Exec(`DELETE FROM user_roles WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("clear user roles: %w", err)
	}

	// Always re-add the default role
	if _, err := tx.Exec(
		`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
		userID, DefaultRoleID,
	); err != nil {
		return fmt.Errorf("assign default role: %w", err)
	}

	// Add requested roles (skip the default, already added; skip Owner if not the owner)
	for _, roleID := range roleIDs {
		if roleID == DefaultRoleID {
			continue
		}
		if roleID == "role_owner" && !user.IsOwner {
			return fmt.Errorf("cannot assign Owner role to non-owner")
		}
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`,
			userID, roleID,
		); err != nil {
			return fmt.Errorf("assign role %s: %w", roleID, err)
		}
	}

	// If the user is the owner, ensure the Owner role is still assigned
	if user.IsOwner {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, 'role_owner')`,
			userID,
		); err != nil {
			return fmt.Errorf("ensure owner role: %w", err)
		}
	}

	return tx.Commit()
}

// scanUserRow scans a user from a *sql.Rows (as opposed to *sql.Row).
func scanUserRow(rows *sql.Rows) (*models.User, error) {
	var u models.User
	var email sql.NullString
	err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &email, &u.IsOwner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	if email.Valid {
		u.Email = &email.String
	}
	return &u, nil
}
