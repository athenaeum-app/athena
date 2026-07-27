// What changed in this build, shown once after the client replaces itself.
//
// watchForNewBuild() in staleClient.ts reloads the page out from under whoever
// is using it when the server moves to a new build. That is the right thing to
// do and it looks like a crash, so this is the explanation the reload owes them.
//
// Entries are written by hand and are optional: a version that is not listed
// here shows nothing at all, so a release with nothing worth saying costs
// nothing. AGENTS.md covers who writes an entry and who approves the wording.
export const RELEASE_NOTES: Record<string, string[]> = {
    '2.8.0': ['The app now displays release notes when updated.'],
    '2.8.1': ['Security update for the desktop app.'],
    '2.9.0': [
        'Tag suggestions now rank by the archive you are writing into.',
        'Sending while a file is still uploading no longer loses the attachment.',
    ],
}

// Which build this browser last ran. localStorage rather than sessionStorage:
// the whole point is surviving the reload, and the desktop shell's content
// reload only promises cookies and localStorage come back (staleClient.ts).
const LAST_SEEN_KEY = 'athena-last-seen-version'

// Exported for its own sake: the decision is worth testing apart from storage
// and from the build's real version.
//
// Nothing stored means a browser that has never run Athena, and greeting a
// first-time user with the changelog for a release they were not here for is
// noise. That case shows nothing and only records where it started.
export function notesFor(
    current: string,
    lastSeen: string | null,
    notes: Record<string, string[]> = RELEASE_NOTES,
): string[] | null {
    if (!lastSeen || lastSeen === current) return null
    return notes[current] ?? null
}

function readLastSeen(): string | null {
    try {
        return localStorage.getItem(LAST_SEEN_KEY)
    } catch {
        return null
    }
}

// Called on every boot, including the ones that show nothing. A browser that
// skipped several versions would otherwise keep reporting the release it last
// displayed rather than the one it is running.
export function markVersionSeen(): void {
    try {
        localStorage.setItem(LAST_SEEN_KEY, __APP_VERSION__)
    } catch {
        // Private mode with storage disabled. With no "last seen" to compare
        // against, the notice never fires, which beats firing on every load.
    }
}

// The notes owed to whoever is looking at this page, if any. Must be read
// before markVersionSeen() overwrites the value it depends on.
export function pendingNotes(): string[] | null {
    return notesFor(__APP_VERSION__, readLastSeen())
}

// The running build's notes for a surface that shows them on demand rather than
// once, so dismissing the notice does not throw them away.
export function currentNotes(): string[] | null {
    return RELEASE_NOTES[__APP_VERSION__] ?? null
}
