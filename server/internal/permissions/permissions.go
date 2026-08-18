// Package permissions defines the 19 fine-grained permission flags used by
// the role system. Flags are stored as a bitmask in a uint32.
//
// A user's effective permissions are the bitwise OR of all their roles'
// permission bitmasks. The ADMINISTRATOR flag is a wildcard that grants
// every other flag: check it first via HasAdministrator().
package permissions

// Flag is a single permission bit.
type Flag uint32

// Permission flags. The order doesn't matter; the values must be unique
// powers of two.
const (
	// Content: Moments
	ViewMoments     Flag = 1 << 0
	CreateMoment    Flag = 1 << 1
	EditOwnMoment   Flag = 1 << 2
	EditAnyMoment   Flag = 1 << 3
	DeleteOwnMoment Flag = 1 << 4
	DeleteAnyMoment Flag = 1 << 5

	// Content: Archives & Tags
	ManageArchives Flag = 1 << 6
	ManageTags     Flag = 1 << 7

	// Chat
	ViewChat             Flag = 1 << 8
	SendChatMessage      Flag = 1 << 9
	EditOwnChatMessage   Flag = 1 << 10
	DeleteOwnChatMessage Flag = 1 << 11
	DeleteAnyChatMessage Flag = 1 << 12

	// Assets
	UploadAsset Flag = 1 << 13
	DeleteAsset Flag = 1 << 14

	// Administration
	ManageUsers   Flag = 1 << 15
	ManageRoles   Flag = 1 << 16
	ManageServer  Flag = 1 << 17
	ViewAuditLog  Flag = 1 << 18
	Administrator Flag = 1 << 19

	// v2.1 additions (ADR-0013). New bits added additively, defaulting to 0
	// on existing roles. Not a width change.
	PinMoment     Flag = 1 << 20 // pin/unpin moments (library-shared)
	ManageTodos   Flag = 1 << 21 // create/edit/delete todo lists & items
	ManageCanvas  Flag = 1 << 22 // create/edit/delete canvases & nodes
	ManageBackups Flag = 1 << 23 // list/create/download/restore backups

	// Projects module. Additive like the v2.1 bits: defaults to 0 on
	// existing roles, so only Admin/Owner (wildcard or AllFlags) have it
	// until a role is edited.
	ManageProjects Flag = 1 << 24 // create/edit/delete projects, stages, cards

	// AllFlags is the union of every flag except Administrator.
	// Administrator is a wildcard, see Has().
	AllFlags Flag = ViewMoments | CreateMoment | EditOwnMoment | EditAnyMoment |
		DeleteOwnMoment | DeleteAnyMoment | ManageArchives | ManageTags |
		ViewChat | SendChatMessage | EditOwnChatMessage | DeleteOwnChatMessage |
		DeleteAnyChatMessage | UploadAsset | DeleteAsset | ManageUsers |
		ManageRoles | ManageServer | ViewAuditLog | PinMoment | ManageTodos |
		ManageCanvas | ManageBackups | ManageProjects
)

// Has reports whether the given permission set grants the requested flag.
// Administrator is a wildcard: if set, every flag is granted.
func Has(perms Flag, flag Flag) bool {
	if perms&Administrator != 0 {
		return true
	}
	return perms&flag != 0
}

// HasAdministrator reports whether the permission set includes the
// Administrator wildcard flag.
func HasAdministrator(perms Flag) bool {
	return perms&Administrator != 0
}

// Union returns the bitwise OR of all given permission sets. Used to
// compute a user's effective permissions from their roles.
func Union(flags ...Flag) Flag {
	var result Flag
	for _, f := range flags {
		result |= f
	}
	return result
}

// Preset role permission bundles. These define what each built-in role
// grants. The Owner role always includes Administrator and is not editable.

// OwnerPerms grants everything.
const OwnerPerms Flag = AllFlags | Administrator

// AdminPerms grants everything except ManageRoles and Administrator.
const AdminPerms Flag = AllFlags &^ ManageRoles

// EditorPerms is the trusted collaborator role.
const EditorPerms Flag = ViewMoments | CreateMoment | EditOwnMoment |
	DeleteOwnMoment | ManageArchives | ManageTags | ViewChat |
	SendChatMessage | EditOwnChatMessage | DeleteOwnChatMessage |
	UploadAsset

// ViewerPerms is the default role every user holds (migration 0008), and so is
// the floor for the whole library: it can see everything and add nothing to it:
// no moments, no archives, no tags, no uploads. Contributing is granted
// deliberately, by assigning Editor or a custom role, rather than arriving with
// the invite.
//
// Chat is the exception, and deliberately so: talking is not the same as
// writing to the library. A member who cannot post a moment can still ask
// about one, which is most of the point of having them in the library at all.
// That includes fixing a typo or retracting what they just said: being able to
// post but not unpost is not a coherent floor, and it is their own message
// either way. Editing or deleting anyone else's still takes a wider role.
const ViewerPerms Flag = ViewMoments | ViewChat | SendChatMessage | EditOwnChatMessage | DeleteOwnChatMessage
