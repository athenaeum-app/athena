package sync

import (
	"log"
	"time"
)

// PruneFunc is the callback shape for domain-level prune operations. The
// domain package supplies concrete implementations (e.g.
// domain.PruneDeletedMoments) at wiring time, so this package does not
// import domain directly and can be developed in parallel.
type PruneFunc func(olderThanDays int) (int64, error)

// StartPruneWorker launches a goroutine that periodically calls the
// supplied domain prune callbacks. If interval is 0 the worker is not
// started (pruning disabled) and the function returns immediately.
//
// pruneMoments and pruneChat may be nil; nil callbacks are skipped so the
// caller can wire only the pruners that exist.
func StartPruneWorker(interval time.Duration, pruneAfterDays int, pruneMoments, pruneChat PruneFunc) {
	if interval == 0 {
		log.Println("Prune interval is 0; background pruning disabled.")
		return
	}

	log.Printf("Background pruning will run every %s, pruning entries older than %d days", interval, pruneAfterDays)

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for range ticker.C {
			runPrune(pruneMoments, pruneAfterDays, "moments")
			runPrune(pruneChat, pruneAfterDays, "chat")
		}
	}()
}

func runPrune(fn PruneFunc, olderThanDays int, label string) {
	if fn == nil {
		return
	}
	n, err := fn(olderThanDays)
	if err != nil {
		log.Printf("Prune %s failed: %v", label, err)
		return
	}
	if n > 0 {
		log.Printf("Pruned %d %s entries older than %d days", n, label, olderThanDays)
	}
}
