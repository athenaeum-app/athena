package auth

import (
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/permissions"
)

// setupDB opens a fresh migrated database in a temp directory and registers
// cleanup. Each test gets an isolated database.
func setupDB(t *testing.T) {
	t.Helper()
	path := t.TempDir() + "/test.db"
	if err := db.Open(path); err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
		db.DB = nil
	})
}

func TestRegister_FirstUserBecomesOwner(t *testing.T) {
	setupDB(t)

	user, err := Register("alice", "password123", nil)
	if err != nil {
		t.Fatalf("register owner: %v", err)
	}
	if !user.IsOwner {
		t.Error("first user should be owner")
	}

	roles, err := GetUserRoles(user.ID)
	if err != nil {
		t.Fatalf("get roles: %v", err)
	}
	var hasOwner, hasDefault bool
	for _, r := range roles {
		if r.ID == OwnerRoleID {
			hasOwner = true
		}
		if r.ID == DefaultRoleID {
			hasDefault = true
		}
	}
	if !hasOwner {
		t.Error("owner should hold the Owner role")
	}
	if !hasDefault {
		t.Error("owner should also hold the default role")
	}

	perms, err := GetUserPermissions(user.ID)
	if err != nil {
		t.Fatalf("get perms: %v", err)
	}
	if !permissions.HasAdministrator(perms) {
		t.Error("owner should have the Administrator wildcard")
	}
}

func TestRegister_SecondUserNeedsInvite(t *testing.T) {
	setupDB(t)
	if _, err := Register("alice", "password123", nil); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	_, err := Register("bob", "password123", nil)
	if err != ErrInviteRequired {
		t.Errorf("expected ErrInviteRequired, got %v", err)
	}
}

func TestRegister_WithValidInvite(t *testing.T) {
	setupDB(t)
	owner, err := Register("alice", "password123", nil)
	if err != nil {
		t.Fatalf("register owner: %v", err)
	}

	inv, err := CreateInvite(owner.ID, 1, nil)
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}

	bob, err := Register("bob", "password123", &inv.ID)
	if err != nil {
		t.Fatalf("register bob: %v", err)
	}
	if bob.IsOwner {
		t.Error("second user should not be owner")
	}

	// bob should hold the default role only.
	roles, err := GetUserRoles(bob.ID)
	if err != nil {
		t.Fatalf("get roles: %v", err)
	}
	if len(roles) != 1 || roles[0].ID != DefaultRoleID {
		t.Errorf("expected bob to hold only the default role, got %v", roles)
	}
}

func TestRegister_DuplicateUsername(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 5, nil)

	if _, err := Register("alice", "different", &inv.ID); err != ErrUsernameTaken {
		t.Errorf("expected ErrUsernameTaken, got %v", err)
	}
}

func TestRegister_InvalidInvite(t *testing.T) {
	setupDB(t)
	if _, err := Register("alice", "password123", nil); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	bogus := "does-not-exist"
	if _, err := Register("bob", "password123", &bogus); err != ErrInviteInvalid {
		t.Errorf("expected ErrInviteInvalid, got %v", err)
	}
}

// TestRegister_SingleUseInviteIsExhausted guards the invite-only registration
// model: a one-use invite must not be reusable after it has been consumed.
func TestRegister_SingleUseInviteIsExhausted(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, err := CreateInvite(owner.ID, 1, nil)
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}

	if _, err := Register("bob", "password123", &inv.ID); err != nil {
		t.Fatalf("first use should succeed: %v", err)
	}

	// Second use of the same single-use invite must fail.
	_, err = Register("carol", "password123", &inv.ID)
	if err == nil {
		t.Fatal("single-use invite was reusable after exhaustion: invite-only registration is broken")
	}
	if err != ErrInviteInvalid && err != ErrInviteExhausted {
		t.Errorf("expected exhaustion error, got %v", err)
	}
}

func TestRegister_MultiUseInviteDecrements(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 2, nil)

	if _, err := Register("bob", "password123", &inv.ID); err != nil {
		t.Fatalf("first use: %v", err)
	}
	if _, err := Register("carol", "password123", &inv.ID); err != nil {
		t.Fatalf("second use: %v", err)
	}
	// Third use should now be exhausted.
	if _, err := Register("dave", "password123", &inv.ID); err == nil {
		t.Error("two-use invite should be exhausted after two registrations")
	}
}

func TestLogin_And_Session(t *testing.T) {
	setupDB(t)
	SetConfig(&config.Config{SessionExpiryDays: 30})
	if _, err := Register("alice", "password123", nil); err != nil {
		t.Fatalf("register: %v", err)
	}

	// Wrong password.
	if _, err := Login("alice", "wrong", false, "1.2.3.4", "test"); err != ErrInvalidCredentials {
		t.Errorf("expected ErrInvalidCredentials for wrong password, got %v", err)
	}
	// Unknown user.
	if _, err := Login("nobody", "password123", false, "1.2.3.4", "test"); err != ErrInvalidCredentials {
		t.Errorf("expected ErrInvalidCredentials for unknown user, got %v", err)
	}

	// Correct login with expiry.
	sess, err := Login("alice", "password123", false, "1.2.3.4", "test")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if sess.ExpiresAt == nil {
		t.Error("expected a sliding expiry when stayLoggedIn is false")
	}

	got, err := GetSession(sess.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if got.UserID != sess.UserID {
		t.Error("session user mismatch")
	}

	// Logout removes it.
	if err := Logout(sess.ID); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := GetSession(sess.ID); err != ErrSessionNotFound {
		t.Errorf("expected ErrSessionNotFound after logout, got %v", err)
	}
}

func TestLogin_StayLoggedIn_NoExpiry(t *testing.T) {
	setupDB(t)
	SetConfig(&config.Config{SessionExpiryDays: 30})
	Register("alice", "password123", nil)

	sess, err := Login("alice", "password123", true, "", "")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if sess.ExpiresAt != nil {
		t.Error("stayLoggedIn session should never expire")
	}
}

func TestGetSession_Expired(t *testing.T) {
	setupDB(t)
	Register("alice", "password123", nil)

	// Insert a session that already expired.
	past := time.Now().Add(-time.Hour)
	_, err := db.DB.Exec(
		`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) SELECT 'expired', id, ?, '', '' FROM users LIMIT 1`,
		past,
	)
	if err != nil {
		t.Fatalf("insert expired session: %v", err)
	}
	if _, err := GetSession("expired"); err != ErrSessionExpired {
		t.Errorf("expected ErrSessionExpired, got %v", err)
	}
}

func TestGetUserPermissions_UnionOfRoles(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 1, nil)
	bob, _ := Register("bob", "password123", &inv.ID)

	// Give bob a custom role with ManageTags.
	role, err := CreateRole("Tagger", "#fff", 5, permissions.ManageTags|permissions.ViewMoments)
	if err != nil {
		t.Fatalf("create role: %v", err)
	}
	if err := AssignRole(bob.ID, role.ID); err != nil {
		t.Fatalf("assign role: %v", err)
	}

	perms, err := GetUserPermissions(bob.ID)
	if err != nil {
		t.Fatalf("get perms: %v", err)
	}
	if !permissions.Has(perms, permissions.ManageTags) {
		t.Error("bob should have ManageTags from his custom role")
	}
	if permissions.HasAdministrator(perms) {
		t.Error("bob should not be an administrator")
	}
}

// widerDefaultPerms is a deliberately generous default role: several low bits
// set, so that any role granted on top of it overlaps. The overlap is the
// point of the two tests below, not the specific bundle. The shipped default
// (ViewerPerms) is narrow enough that a summing implementation could get away
// with it.
const widerDefaultPerms = permissions.ViewMoments | permissions.ViewChat |
	permissions.SendChatMessage | permissions.CreateMoment |
	permissions.EditOwnMoment | permissions.DeleteOwnMoment

// TestGetUserPermissions_OverlappingRolesDoNotCarry pins the bug that locked
// the owner out of their own server. Every user also holds the default role,
// so any role that repeats one of its bits used to make SUM()'s addition carry
// into the flags above it. Here the extra role deliberately re-grants
// ViewMoments (bit 0, which the default also grants) alongside ManageRoles, so
// a summing implementation loses ManageRoles entirely.
func TestGetUserPermissions_OverlappingRolesDoNotCarry(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 1, nil)
	bob, _ := Register("bob", "password123", &inv.ID)

	defaultPerms := permissions.Flag(widerDefaultPerms)
	if err := UpdateRole(DefaultRoleID, nil, nil, nil, &defaultPerms); err != nil {
		t.Fatalf("widen the default role: %v", err)
	}
	role, err := CreateRole("Overlapping", "#fff", 5, permissions.ViewMoments|permissions.ManageRoles)
	if err != nil {
		t.Fatalf("create role: %v", err)
	}
	if err := AssignRole(bob.ID, role.ID); err != nil {
		t.Fatalf("assign role: %v", err)
	}

	perms, err := GetUserPermissions(bob.ID)
	if err != nil {
		t.Fatalf("get perms: %v", err)
	}
	if want := widerDefaultPerms | permissions.ViewMoments | permissions.ManageRoles; perms != want {
		t.Errorf("effective perms = %d, want %d (the OR of both roles)", perms, want)
	}
	if !permissions.Has(perms, permissions.ManageRoles) {
		t.Error("ManageRoles was lost when two roles shared a lower bit")
	}
}

// TestGetUserPermissions_OwnerKeepsAdministrator is the end-to-end version of
// the same bug: the owner holds Owner + the default role out of the box, and
// Owner's bits fully contain the default's, so the overlap is total.
func TestGetUserPermissions_OwnerKeepsAdministrator(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)

	defaultPerms := permissions.Flag(widerDefaultPerms)
	if err := UpdateRole(DefaultRoleID, nil, nil, nil, &defaultPerms); err != nil {
		t.Fatalf("widen the default role: %v", err)
	}

	perms, err := GetUserPermissions(owner.ID)
	if err != nil {
		t.Fatalf("get perms: %v", err)
	}
	if !permissions.HasAdministrator(perms) {
		t.Error("owner lost the Administrator wildcard")
	}
	for _, flag := range []struct {
		name string
		f    permissions.Flag
	}{
		{"ManageRoles", permissions.ManageRoles},
		{"ManageUsers", permissions.ManageUsers},
		{"ManageServer", permissions.ManageServer},
	} {
		if !permissions.Has(perms, flag.f) {
			t.Errorf("owner cannot %s on their own server", flag.name)
		}
	}
}
