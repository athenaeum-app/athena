package domain

import (
	"testing"

	"github.com/athenaeum-app/athena/server/internal/models"
)

// A node kind the client can create has to survive the round trip. Kinds not on
// the allow-list are rewritten to text, so a kind added to the client and
// forgotten here does not fail loudly: it silently becomes a text node holding
// an id, which is why this test enumerates the whole set rather than the two
// that were added last.
func TestCreateCanvasNode_PersistsEveryKnownKind(t *testing.T) {
	setupDB(t)
	canvas, err := CreateCanvas("Board", nil)
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}

	kinds := []string{
		models.CanvasNodeMomentRef,
		models.CanvasNodeText,
		models.CanvasNodeImage,
		models.CanvasNodeSticky,
		models.CanvasNodeShape,
		models.CanvasNodeLink,
		models.CanvasNodeTodoRef,
		models.CanvasNodeProjectRef,
		models.CanvasNodeCanvasRef,
	}
	for _, kind := range kinds {
		node, err := CreateCanvasNode(canvas.ID, kind, 0, 0, 100, 100, "", nil)
		if err != nil {
			t.Fatalf("create %s node: %v", kind, err)
		}
		if node.Kind != kind {
			t.Errorf("kind %q was stored as %q", kind, node.Kind)
		}
	}
}

func TestCreateCanvasNode_UnknownKindFallsBackToText(t *testing.T) {
	setupDB(t)
	canvas, err := CreateCanvas("Board", nil)
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}
	node, err := CreateCanvasNode(canvas.ID, "wormhole", 0, 0, 100, 100, "", nil)
	if err != nil {
		t.Fatalf("create node: %v", err)
	}
	if node.Kind != models.CanvasNodeText {
		t.Errorf("unknown kind stored as %q, want %q", node.Kind, models.CanvasNodeText)
	}
}
