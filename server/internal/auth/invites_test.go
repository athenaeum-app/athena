package auth

import (
	"testing"
	"time"
)

func TestValidateInvite_UnknownAndExpired(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)

	if err := ValidateInvite("nope"); err != ErrInviteInvalid {
		t.Errorf("unknown invite should be invalid, got %v", err)
	}

	past := time.Now().Add(-time.Hour)
	expired, _ := CreateInvite(owner.ID, 5, &past)
	if err := ValidateInvite(expired.ID); err != ErrInviteInvalid {
		t.Errorf("expired invite should be invalid, got %v", err)
	}
}

func TestConsumeInvite_Decrements(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 2, nil)

	if err := ConsumeInvite(inv.ID); err != nil {
		t.Fatalf("consume 1: %v", err)
	}
	// Still listed with a use left, so an admin can see it is live.
	invites, _ := ListInvites()
	if len(invites) != 1 || invites[0].UsesRemaining != 1 {
		t.Fatalf("expected 1 invite with 1 use left, got %+v", invites)
	}

	if err := ConsumeInvite(inv.ID); err != nil {
		t.Fatalf("consume 2: %v", err)
	}
	// Now exhausted. Spending the last use revokes the invite outright
	// rather than leaving a dead row reading "0 use(s) left".
	if invites, _ := ListInvites(); len(invites) != 0 {
		t.Errorf("exhausted invite should be deleted, still listed: %+v", invites)
	}
	// And it is gone, not merely spent, so it reads as unknown.
	if err := ConsumeInvite(inv.ID); err != ErrInviteInvalid {
		t.Errorf("consuming a revoked invite should be ErrInviteInvalid, got %v", err)
	}
}

// An unlimited invite (-1) must survive being consumed: the delete is guarded
// on reaching exactly 0, and -1 never counts down.
func TestConsumeInvite_UnlimitedSurvives(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 0, nil) // 0 or less means unlimited

	for i := 0; i < 3; i++ {
		if err := ConsumeInvite(inv.ID); err != nil {
			t.Fatalf("consume %d: %v", i+1, err)
		}
	}

	invites, _ := ListInvites()
	if len(invites) != 1 {
		t.Fatalf("unlimited invite should survive, got %d invites", len(invites))
	}
	if invites[0].UsesRemaining != -1 {
		t.Errorf("unlimited invite should stay at -1, got %d", invites[0].UsesRemaining)
	}
}

// Registration consumes through the same path, inside its own transaction, so
// a single-use invite is revoked by the registration that spends it.
func TestRegister_RevokesSingleUseInvite(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 1, nil)

	if _, err := Register("bob", "password123", &inv.ID); err != nil {
		t.Fatalf("register bob: %v", err)
	}

	if invites, _ := ListInvites(); len(invites) != 0 {
		t.Errorf("spent single-use invite should be deleted, still listed: %+v", invites)
	}
	// The next arrival cannot reuse the link.
	if _, err := Register("carol", "password123", &inv.ID); err != ErrInviteInvalid {
		t.Errorf("expected ErrInviteInvalid reusing a revoked invite, got %v", err)
	}
}

// A multi-use invite must outlive the registrations it still has room for.
func TestRegister_KeepsMultiUseInviteUntilSpent(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 2, nil)

	if _, err := Register("bob", "password123", &inv.ID); err != nil {
		t.Fatalf("register bob: %v", err)
	}
	invites, _ := ListInvites()
	if len(invites) != 1 || invites[0].UsesRemaining != 1 {
		t.Fatalf("expected the invite to survive with 1 use left, got %+v", invites)
	}

	if _, err := Register("carol", "password123", &inv.ID); err != nil {
		t.Fatalf("register carol: %v", err)
	}
	if invites, _ := ListInvites(); len(invites) != 0 {
		t.Errorf("invite should be revoked once spent, still listed: %+v", invites)
	}
}

func TestListAndRevokeInvite(t *testing.T) {
	setupDB(t)
	owner, _ := Register("alice", "password123", nil)
	inv, _ := CreateInvite(owner.ID, 1, nil)

	invites, err := ListInvites()
	if err != nil {
		t.Fatalf("list invites: %v", err)
	}
	if len(invites) != 1 {
		t.Fatalf("expected 1 invite, got %d", len(invites))
	}

	if err := RevokeInvite(inv.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	// Revoking again is idempotent.
	if err := RevokeInvite(inv.ID); err != nil {
		t.Fatalf("revoke again should be idempotent: %v", err)
	}
	invites, _ = ListInvites()
	if len(invites) != 0 {
		t.Errorf("expected 0 invites after revoke, got %d", len(invites))
	}
}
