# Delta sync via versioned events with short polling

The v2 sync model uses a monotonic library version counter and an `events` table recording every mutation. Clients poll `GET /api/v1/events?since=X` at a short interval (2-5 seconds) to receive only the changes since their last known version. Initial load fetches a paginated window of recent moments plus the current library version; subsequent syncs are delta-only.

This was chosen over v1's whole-snapshot sync (`GET /api/library` returns every moment with full content) because that approach does not scale: 10,000 moments means megabytes of JSON on every open, and the v1 server's `GetExactWordCount` does a full table scan loading every moment's content into memory. Delta sync reduces steady-state sync to kilobytes when nothing has changed.

WebSocket push is deferred to a future enhancement. The delta-sync infrastructure (the event log) is the WebSocket message source, so the upgrade path is clean: add a WebSocket connection that pushes events in real-time, keep polling as a fallback for missed events.

Conflict resolution is hard-reject: writes include an `If-Match` version header; if the resource has been modified since, the server returns `409 Conflict` and the client must refresh and retry. Three-way merge and field-level merge were rejected as disproportionate to the 3-user scale.
