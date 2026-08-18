package auth

import (
	"testing"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/permissions"
)

func TestAssignRole_Idempotent(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	role, _ := CreateRole("Extra", "#abc", 5, permissions.ViewMoments)

	if err := AssignRole(owner.ID, role.ID); err != nil {
		t.Fatalf("assign: %v", err)
	}
	// Re-assigning the same pair must not error.
	if err := AssignRole(owner.ID, role.ID); err != nil {
		t.Fatalf("re-assign should be a no-op: %v", err)
	}
}

func TestUnassignRole_OwnerRoleProtected(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)

	if err := UnassignRole(owner.ID, OwnerRoleID); err != ErrOwnerRoleProtected {
		t.Errorf("expected ErrOwnerRoleProtected, got %v", err)
	}
}

func TestUnassignRole_NonOwnerOK(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	role, _ := CreateRole("Extra", "#abc", 5, permissions.ViewMoments)
	AssignRole(owner.ID, role.ID)

	if err := UnassignRole(owner.ID, role.ID); err != nil {
		t.Fatalf("unassign custom role: %v", err)
	}
	roles, _ := GetUserRoles(owner.ID)
	for _, r := range roles {
		if r.ID == role.ID {
			t.Error("custom role should have been removed")
		}
	}
}

func TestCreateRole_IsCustom(t *testing.T) {
	setupDB(t)
	role, err := CreateRole("Moderator", "#123456", 7, permissions.DeleteAnyMoment)
	if err != nil {
		t.Fatalf("create role: %v", err)
	}
	if role.IsPreset || role.IsDefault {
		t.Error("custom role should be neither preset nor default")
	}
	if role.Permissions != uint32(permissions.DeleteAnyMoment) {
		t.Error("role permissions not stored correctly")
	}
}

func TestUpdateRole_OwnerProtected(t *testing.T) {
	setupDB(t)
	Register("alice", "password123", nil)

	newName := "Hacked"
	if err := UpdateRole(OwnerRoleID, &newName, nil, nil, nil); err != ErrOwnerRoleProtected {
		t.Errorf("expected ErrOwnerRoleProtected, got %v", err)
	}
}

func TestUpdateRole_NotFound(t *testing.T) {
	setupDB(t)
	Register("alice", "password123", nil)

	newName := "Ghost"
	if err := UpdateRole("no-such-role", &newName, nil, nil, nil); err != ErrRoleNotFound {
		t.Errorf("expected ErrRoleNotFound, got %v", err)
	}
}

func TestUpdateRole_PartialUpdate(t *testing.T) {
	setupDB(t)
	Register("alice", "password123", nil)
	role, _ := CreateRole("Base", "#000", 3, permissions.ViewMoments)

	newPerms := permissions.ViewMoments | permissions.CreateMoment
	if err := UpdateRole(role.ID, nil, nil, nil, &newPerms); err != nil {
		t.Fatalf("update role: %v", err)
	}

	roles, _ := ListRoles()
	var found bool
	for _, r := range roles {
		if r.ID == role.ID {
			found = true
			if r.Permissions != uint32(newPerms) {
				t.Errorf("permissions = %d, want %d", r.Permissions, newPerms)
			}
			if r.Name != "Base" {
				t.Error("name should be unchanged by a nil name update")
			}
		}
	}
	if !found {
		t.Error("role not found in list")
	}
}

func TestDeleteRole_PresetProtected(t *testing.T) {
	setupDB(t)
	Register("alice", "password123", nil)

	if err := DeleteRole(DefaultRoleID); err != ErrPresetRoleProtected {
		t.Errorf("deleting a preset role should be protected, got %v", err)
	}
	if err := DeleteRole(OwnerRoleID); err != ErrPresetRoleProtected {
		t.Errorf("deleting the owner role should be protected, got %v", err)
	}
}

func TestDeleteRole_Custom(t *testing.T) {
	setupDB(t)
	Register("alice", "password123", nil)
	role, _ := CreateRole("Temp", "#999", 8, 0)

	if err := DeleteRole(role.ID); err != nil {
		t.Fatalf("delete custom role: %v", err)
	}
	if err := DeleteRole(role.ID); err != ErrRoleNotFound {
		t.Errorf("deleting an already-deleted role should be not found, got %v", err)
	}
}

// presetDefaults is what a freshly migrated server should end up with:
// migration 0007's literals, minus Member, which 0008 retires.
var presetDefaults = map[string]permissions.Flag{
	"role_viewer": permissions.ViewerPerms,
	"role_editor": permissions.EditorPerms,
	"role_admin":  permissions.AdminPerms,
	"role_owner":  permissions.OwnerPerms,
}

// TestPresetRolesHaveDefaultPermissions covers the bug where every preset role
// shipped with permissions = 0. A user invited to a fresh server holds the
// default role, and with it at zero they had no VIEW_MOMENTS, so the library
// looked empty to everyone but the owner.
func TestPresetRolesHaveDefaultPermissions(t *testing.T) {
	setupDB(t)
	if _, err := Register("alice", "password123", nil); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	roles, err := ListRoles()
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	byID := map[string]uint32{}
	for _, r := range roles {
		byID[r.ID] = r.Permissions
	}

	for id, want := range presetDefaults {
		got, ok := byID[id]
		if !ok {
			t.Errorf("preset role %s is missing", id)
			continue
		}
		if got != uint32(want) {
			t.Errorf("%s permissions = %d, want %d", id, got, want)
		}
	}
}

// TestPresetRoleMigrationMatchesConstants pins the numeric literals in the
// migrations to the permission constants. A migration is immutable once
// released, so if a preset bundle ever changes the fix is a new migration.
// This test is what forces that instead of a silent drift.
func TestPresetRoleMigrationMatchesConstants(t *testing.T) {
	for id, want := range map[string]struct {
		flag    permissions.Flag
		literal uint32
	}{
		// 0007 wrote 769; 0011 raised it to 3841 when Viewer gained edit and
		// delete over its own chat messages. 0014 raised Admin and Owner when
		// MANAGE_PROJECTS (bit 24) landed. The literal here tracks the last
		// migration to write the value, which is what a fresh install ends at.
		"role_viewer": {permissions.ViewerPerms, 3841},
		"role_editor": {permissions.EditorPerms, 12247},
		"role_admin":  {permissions.AdminPerms, 32964607},
		"role_owner":  {permissions.OwnerPerms, 33554431},
	} {
		if uint32(want.flag) != want.literal {
			t.Errorf("%s: constant is %d but the migration writes %d; add a new migration",
				id, uint32(want.flag), want.literal)
		}
	}
}

// TestMemberRoleIsRetired: migration 0008 removes it, and anyone who held it
// must come out the other side holding Viewer rather than nothing.
func TestMemberRoleIsRetired(t *testing.T) {
	setupDB(t)
	if _, err := Register("alice", "password123", nil); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	roles, err := ListRoles()
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	for _, r := range roles {
		if r.ID == "role_member" {
			t.Error("role_member still exists after migration 0008")
		}
		if r.ID == DefaultRoleID && !r.IsDefault {
			t.Errorf("%s should be the default role", DefaultRoleID)
		}
		if r.ID != DefaultRoleID && r.IsDefault {
			t.Errorf("%s is also marked default", r.ID)
		}
	}
}

// TestDefaultRoleAddsNothingToTheLibrary is the point of the change: everyone
// holds the default role, so anything it grants is granted to everyone. It may
// read the library and talk about it; it may not add to or alter it.
func TestDefaultRoleAddsNothingToTheLibrary(t *testing.T) {
	setupDB(t)
	if _, err := Register("alice", "password123", nil); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	for _, flag := range []struct {
		name string
		bit  permissions.Flag
	}{
		{"CREATE_MOMENT", permissions.CreateMoment},
		{"EDIT_OWN_MOMENT", permissions.EditOwnMoment},
		{"DELETE_OWN_MOMENT", permissions.DeleteOwnMoment},
		{"UPLOAD_ASSET", permissions.UploadAsset},
		{"MANAGE_ARCHIVES", permissions.ManageArchives},
		{"MANAGE_TAGS", permissions.ManageTags},
		{"PIN_MOMENT", permissions.PinMoment},
		{"MANAGE_TODOS", permissions.ManageTodos},
		{"MANAGE_CANVAS", permissions.ManageCanvas},
	} {
		if permissions.ViewerPerms&flag.bit != 0 {
			t.Errorf("the default role grants %s; it should add nothing to the library", flag.name)
		}
	}

	// ...but it sees everything, and can talk. Chat is deliberately not
	// treated as writing to the library: a member who cannot post a moment
	// can still ask about one.
	for _, flag := range []struct {
		name string
		bit  permissions.Flag
	}{
		{"VIEW_MOMENTS", permissions.ViewMoments},
		{"VIEW_CHAT", permissions.ViewChat},
		{"SEND_CHAT_MESSAGE", permissions.SendChatMessage},
	} {
		if permissions.ViewerPerms&flag.bit == 0 {
			t.Errorf("the default role does not grant %s", flag.name)
		}
	}
}

// TestPresetRoleDefaultsDoNotClobberCustomisations checks the migration's
// `AND permissions = 0` guard: an operator who has already tuned a preset must
// keep their values when the migration runs on their existing database.
func TestPresetRoleDefaultsDoNotClobberCustomisations(t *testing.T) {
	setupDB(t)

	custom := permissions.ViewMoments | permissions.ManageTodos
	if err := UpdateRole("role_viewer", nil, nil, nil, &custom); err != nil {
		t.Fatalf("customise viewer: %v", err)
	}

	// Re-running the migration must leave the customised row untouched.
	if _, err := db.DB.Exec(
		`UPDATE roles SET permissions = 769 WHERE id = 'role_viewer' AND permissions = 0`,
	); err != nil {
		t.Fatalf("re-run migration statement: %v", err)
	}

	var got uint32
	if err := db.DB.QueryRow(`SELECT permissions FROM roles WHERE id = 'role_viewer'`).Scan(&got); err != nil {
		t.Fatalf("read viewer: %v", err)
	}
	if got != uint32(custom) {
		t.Errorf("customised Viewer permissions = %d, want %d", got, custom)
	}
}
