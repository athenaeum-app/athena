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
    '2.10.0': [
        'Link previews can now be shown where the link is, instead of stacked at the end. Turn it on in Settings.',
    ],
    '2.10.1': [
        'Clicking outside an enlarged image now closes it.',
        'Dragging a card on a narrow window no longer selects its text instead of swiping.',
    ],
    '2.11.0': ['Past release notes can now be read any time in Settings, under About.'],
    '2.12.0': [
        "A server that can't be reached now says so and reconnects on its own, instead of showing a login form that couldn't work.",
        'Losing the connection mid-session shows a banner and leaves your writing untouched.',
    ],
    '2.12.1': ['The Settings tabs no longer scroll sideways; the panel widens to fit them.'],
    '2.12.2': ['The Settings panel now widens far enough for its tabs at any UI scale, not just the default one.'],
    '2.12.3': ['Reaching for a scrollbar in chat no longer opens the message menu over the page.'],
    '2.13.0': [
        'Uploaded videos can now sit several to a row instead of one full-width player each. Set it in Settings.',
        "An attachment's file name no longer collapses to a column of single letters in a narrow panel.",
    ],
    '2.14.0': [
        'A canvas reference now opens that board, framed on its contents.',
        'Canvas references can show a small map of the board. Turn it on in Settings.',
        'Moment references can render in full instead of a line of plain text, up to a height you set.',
        'Chat history now loads on iPhones running iOS 16.3 or older.',
    ],
    '2.14.1': ['Smaller markdown headings are no longer near-black; every level now takes the theme colour.'],
    '2.15.0': [
        'Editing a moment now uses the whole window instead of a small box with empty space under it.',
        'The composer grows as you write, up to a limit, rather than staying at a fixed height.',
    ],
    '2.15.1': ['A moment with many tags no longer squeezes the writing area; the tag strip scrolls instead.'],
    '2.15.2': ['Fixed the moment text drawing over the tag field when editing with the tag list open.'],
    '2.15.3': ["A to-do list's buttons no longer spill over the list beside it."],
    '2.16.0': [
        'New Projects module: long-running efforts with an overview document, a milestone board, and a graveyard that keeps every dismissed card.',
        'Projects can be embedded anywhere as live summary cards, and their documents use the same editor as moments.',
        "The login page's bookshelf now drifts behind the main app and Projects. Each can be turned off in Settings.",
        'Horizontal scrollbars now match the theme instead of the browser default.',
        'Royal Blue buttons no longer wash out their labels.',
    ],
    '2.16.1': [
        'Projects is now reachable on phones, under More, and its screens fit a narrow window.',
        'Starting a project is now a card in the grid rather than a button in the bar.',
        'The Projects bar no longer ignores clicks in the desktop app.',
    ],
    '2.17.0': [
        'Projects can open as a large window over your library instead of filling the screen. Turn it on in Settings.',
        'Escape now closes Projects in the desktop app.',
        'Leaving Projects is now a back arrow on the left, matching the way a project returns to the list.',
    ],
    '2.17.1': [
        'Projects now opens as a window over your library by default. Turn it off in Settings to have it fill the screen.',
    ],
    '2.18.0': [
        'Clicking a tag on a moment now filters by it, the same as clicking it in the tag bar. Turn it off in Settings.',
        'The desktop layout no longer wastes a strip of height, so it fits a browser window without scrolling.',
    ],
    '2.18.1': [
        'The composer now reopens on the archive you last chose, instead of resetting after every moment.',
    ],
    '2.18.2': [
        'The archive you pick in the composer now sticks after you post, whichever archive you happen to be reading.',
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

// Order two versions by their numeric parts. Sorting these as plain strings
// gets it backwards the moment a component reaches double digits: "2.9.0" sorts
// above "2.10.0" because "9" > "1" character by character.
export function compareVersions(a: string, b: string): number {
    const parts = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
    const [pa, pb] = [parts(a), parts(b)]
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

// Every release older than the one running, newest first, for a history view.
//
// Strictly older, so the running version is not repeated under a heading that
// says "earlier". That also does the right thing for a build with no entry of
// its own: its predecessor is simply the first row, which is the last thing
// anyone was actually told about.
export function releaseHistory(
    current: string = __APP_VERSION__,
    notes: Record<string, string[]> = RELEASE_NOTES,
): { version: string; notes: string[] }[] {
    return Object.keys(notes)
        .filter((version) => compareVersions(version, current) < 0)
        .sort((a, b) => compareVersions(b, a))
        .map((version) => ({ version, notes: notes[version] }))
}
