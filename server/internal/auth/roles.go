package auth

import (
	"database/sql"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/google/uuid"
)

// AssignRole links a user to a role. Idempotent: re-assigning an existing
// pair is a no-op (INSERT OR IGNORE).
func AssignRole(userID, roleID string) error {
	_, err := db.DB.Exec(
		`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`,
		userID, roleID,
	)
	return err
}

// UnassignRole removes a role from a user. The Owner role cannot be removed
// from the owner: that would lock the server out of administration.
func UnassignRole(userID, roleID string) error {
	if roleID == OwnerRoleID {
		var isOwner int64
		if err := db.DB.QueryRow(`SELECT is_owner FROM users WHERE id = ?`, userID).Scan(&isOwner); err != nil {
			if err == sql.ErrNoRows {
				return ErrUserNotFound
			}
			return err
		}
		if isOwner != 0 {
			return ErrOwnerRoleProtected
		}
	}
	_, err := db.DB.Exec(
		`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`,
		userID, roleID,
	)
	return err
}

// ListRoles returns every role ordered by position ascending.
func ListRoles() ([]models.Role, error) {
	rows, err := db.DB.Query(
		`SELECT id, name, color, position, is_preset, is_default, permissions, created_at, updated_at
		 FROM roles ORDER BY position ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	roles := []models.Role{}
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		roles = append(roles, *r)
	}
	return roles, rows.Err()
}

// GetUserRoles returns the roles assigned to a user, ordered by position.
func GetUserRoles(userID string) ([]models.Role, error) {
	rows, err := db.DB.Query(
		`SELECT r.id, r.name, r.color, r.position, r.is_preset, r.is_default, r.permissions, r.created_at, r.updated_at
		 FROM user_roles ur
		 JOIN roles r ON r.id = ur.role_id
		 WHERE ur.user_id = ?
		 ORDER BY r.position ASC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	roles := []models.Role{}
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		roles = append(roles, *r)
	}
	return roles, rows.Err()
}

// CreateRole inserts a new custom (non-preset, non-default) role.
func CreateRole(name, color string, position int, perms permissions.Flag) (*models.Role, error) {
	role := &models.Role{
		ID:          uuid.NewString(),
		Name:        name,
		Color:       color,
		Position:    position,
		IsPreset:    false,
		IsDefault:   false,
		Permissions: uint32(perms),
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	_, err := db.DB.Exec(
		`INSERT INTO roles (id, name, color, position, is_preset, is_default, permissions) VALUES (?, ?, ?, ?, 0, 0, ?)`,
		role.ID, role.Name, role.Color, role.Position, role.Permissions,
	)
	if err != nil {
		return nil, err
	}
	return role, nil
}

// UpdateRole performs a partial update of a role. nil pointer arguments mean
// "leave this field unchanged". The Owner role is immutable.
func UpdateRole(roleID string, name, color *string, position *int, perms *permissions.Flag) error {
	if roleID == OwnerRoleID {
		return ErrOwnerRoleProtected
	}

	// Verify the role exists so we can return a typed not-found error
	// rather than a silent no-op.
	var exists int64
	if err := db.DB.QueryRow(`SELECT 1 FROM roles WHERE id = ?`, roleID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			return ErrRoleNotFound
		}
		return err
	}

	// Build the SET clause dynamically from the provided fields.
	setParts := []string{}
	args := []any{}
	if name != nil {
		setParts = append(setParts, "name = ?")
		args = append(args, *name)
	}
	if color != nil {
		setParts = append(setParts, "color = ?")
		args = append(args, *color)
	}
	if position != nil {
		setParts = append(setParts, "position = ?")
		args = append(args, *position)
	}
	if perms != nil {
		setParts = append(setParts, "permissions = ?")
		args = append(args, uint32(*perms))
	}
	if len(setParts) == 0 {
		return nil
	}
	setParts = append(setParts, "updated_at = ?")
	args = append(args, time.Now())
	args = append(args, roleID)

	stmt := "UPDATE roles SET " + joinComma(setParts) + " WHERE id = ?"
	_, err := db.DB.Exec(stmt, args...)
	return err
}

// DeleteRole removes a custom role. Preset roles (Member, Viewer, Editor,
// Admin, Owner) cannot be deleted.
func DeleteRole(roleID string) error {
	var isPreset int64
	if err := db.DB.QueryRow(`SELECT is_preset FROM roles WHERE id = ?`, roleID).Scan(&isPreset); err != nil {
		if err == sql.ErrNoRows {
			return ErrRoleNotFound
		}
		return err
	}
	if isPreset != 0 || roleID == OwnerRoleID {
		return ErrPresetRoleProtected
	}
	_, err := db.DB.Exec(`DELETE FROM roles WHERE id = ?`, roleID)
	return err
}

// scanRole reads a role row from either a *sql.Rows or *sql.Row. We accept
// the scanner interface so the same helper works for both query styles.
func scanRole(s scanner) (*models.Role, error) {
	var r models.Role
	var isPreset, isDefault int64
	if err := s.Scan(
		&r.ID, &r.Name, &r.Color, &r.Position,
		&isPreset, &isDefault, &r.Permissions,
		&r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		return nil, err
	}
	r.IsPreset = isPreset != 0
	r.IsDefault = isDefault != 0
	return &r, nil
}

// scanner is the interface shared by *sql.Rows and *sql.Row.
type scanner interface {
	Scan(dest ...any) error
}

// joinComma is a tiny helper to avoid pulling in strings.Join for two or
// three elements.
func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}
