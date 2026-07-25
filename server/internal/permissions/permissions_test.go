package permissions

import (
	"math/bits"
	"testing"
)

func TestHas_DirectFlag(t *testing.T) {
	perms := ViewMoments | CreateMoment
	if !Has(perms, ViewMoments) {
		t.Error("expected ViewMoments to be granted")
	}
	if !Has(perms, CreateMoment) {
		t.Error("expected CreateMoment to be granted")
	}
	if Has(perms, DeleteAnyMoment) {
		t.Error("did not expect DeleteAnyMoment to be granted")
	}
}

func TestHas_AdministratorWildcard(t *testing.T) {
	// Administrator alone should grant any other flag, even ones not present.
	perms := Administrator
	for _, f := range allFlags() {
		if !Has(perms, f) {
			t.Errorf("Administrator wildcard should grant flag %d", f)
		}
	}
	// Administrator should also grant a flag it doesn't literally contain.
	if !Has(Administrator, ManageServer) {
		t.Error("Administrator should grant ManageServer via wildcard")
	}
}

func TestHas_ZeroPermsGrantsNothing(t *testing.T) {
	var none Flag
	if Has(none, ViewMoments) {
		t.Error("empty permission set should grant nothing")
	}
	if HasAdministrator(none) {
		t.Error("empty permission set is not administrator")
	}
}

func TestHasAdministrator(t *testing.T) {
	if HasAdministrator(ViewMoments | CreateMoment) {
		t.Error("non-admin perms should not report administrator")
	}
	if !HasAdministrator(AllFlags | Administrator) {
		t.Error("perms including Administrator should report administrator")
	}
}

func TestUnion(t *testing.T) {
	got := Union(ViewMoments, CreateMoment, ViewMoments)
	want := ViewMoments | CreateMoment
	if got != want {
		t.Errorf("Union = %d, want %d", got, want)
	}
	if Union() != 0 {
		t.Error("Union of nothing should be 0")
	}
}

func TestFlagsAreDistinctPowersOfTwo(t *testing.T) {
	seen := map[Flag]bool{}
	for _, f := range allFlags() {
		if bits.OnesCount32(uint32(f)) != 1 {
			t.Errorf("flag %d is not a single power of two", f)
		}
		if seen[f] {
			t.Errorf("flag %d is duplicated", f)
		}
		seen[f] = true
	}
}

func TestAllFlagsExcludesAdministrator(t *testing.T) {
	if AllFlags&Administrator != 0 {
		t.Error("AllFlags must not include the Administrator wildcard")
	}
	// AllFlags should be the union of every non-administrator flag.
	var want Flag
	for _, f := range allFlags() {
		want |= f
	}
	if AllFlags != want {
		t.Errorf("AllFlags = %d, want union of all flags %d", AllFlags, want)
	}
}

func TestPresetBundles(t *testing.T) {
	// Owner has everything, including the wildcard.
	if !HasAdministrator(OwnerPerms) {
		t.Error("OwnerPerms must include Administrator")
	}
	if OwnerPerms&AllFlags != AllFlags {
		t.Error("OwnerPerms must include every flag")
	}

	// Admin has everything except ManageRoles and Administrator.
	if Has(AdminPerms, ManageRoles) {
		t.Error("AdminPerms must not grant ManageRoles")
	}
	if HasAdministrator(AdminPerms) {
		t.Error("AdminPerms must not include the Administrator wildcard")
	}
	if !Has(AdminPerms, ManageUsers) {
		t.Error("AdminPerms should grant ManageUsers")
	}

	// Editor can create/edit own moments but not manage users.
	if !Has(EditorPerms, CreateMoment) || !Has(EditorPerms, EditOwnMoment) {
		t.Error("EditorPerms should allow authoring moments")
	}
	if Has(EditorPerms, ManageUsers) || Has(EditorPerms, EditAnyMoment) {
		t.Error("EditorPerms should not grant admin or edit-any powers")
	}

	// Viewer is the default role, so it is also the library's floor: it reads
	// everything and takes part in chat, but adds nothing to the library.
	for _, f := range []Flag{ViewMoments, ViewChat, SendChatMessage} {
		if !Has(ViewerPerms, f) {
			t.Errorf("ViewerPerms should grant flag %d", f)
		}
	}
	for _, f := range []Flag{CreateMoment, UploadAsset, EditOwnMoment, ManageTags, ManageArchives} {
		if Has(ViewerPerms, f) {
			t.Errorf("ViewerPerms grants flag %d; the default role must not add to the library", f)
		}
	}
}

// allFlags returns every non-wildcard permission flag.
func allFlags() []Flag {
	return []Flag{
		ViewMoments, CreateMoment, EditOwnMoment, EditAnyMoment,
		DeleteOwnMoment, DeleteAnyMoment, ManageArchives, ManageTags,
		ViewChat, SendChatMessage, EditOwnChatMessage, DeleteOwnChatMessage,
		DeleteAnyChatMessage, UploadAsset, DeleteAsset, ManageUsers,
		ManageRoles, ManageServer, ViewAuditLog,
		PinMoment, ManageTodos, ManageCanvas, ManageBackups,
	}
}
