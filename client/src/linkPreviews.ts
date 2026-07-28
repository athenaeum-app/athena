// Locating the bare URLs that an inline preview is allowed to replace.
//
// Inline previews delete the URL text and put a card in its place, so a false
// positive here is destructive rather than merely untidy: matching the
// destination in `[label](url)` would leave `[label](` stranded and take the
// label down with it. Everything below exists to make the match conservative.
//
// The stacked-at-the-bottom previews use extractUrls instead, which is looser on
// purpose: nothing is removed there, so an over-match costs one redundant card.

export interface UrlMatch {
    url: string
    start: number
    end: number
}

// Trailing characters that end a sentence more often than they end a URL.
const TRAILING = /[.,;:!?)]+$/

const BARE_URL = /https?:\/\/[^\s<>"')\]]+/gi

function blank(chars: string[], start: number, end: number): void {
    for (let i = start; i < end && i < chars.length; i++) {
        if (chars[i] !== '\n') chars[i] = ' '
    }
}

// Fenced blocks are masked first because they can contain every other construct
// here. An unterminated fence runs to the end of the content, which is what a
// markdown renderer does with it too.
function maskFences(chars: string[], text: string): void {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n?/gm
    let open: { start: number; marker: string } | null = null
    let m: RegExpExecArray | null
    while ((m = fence.exec(text)) !== null) {
        if (!open) {
            open = { start: m.index, marker: m[1][0] }
        } else if (m[1][0] === open.marker) {
            blank(chars, open.start, m.index + m[0].length)
            open = null
        }
    }
    if (open) blank(chars, open.start, text.length)
}

// Each pass runs against the text masked so far, so a construct already blanked
// cannot match again and offsets stay aligned with the original string.
function maskNonLinkRegions(content: string): string {
    const chars = content.split('')
    maskFences(chars, content)

    const passes: RegExp[] = [
        // Inline code, longest run of backticks first so ``a ` b`` closes right.
        /(`+)[\s\S]*?\1/g,
        // Autolinks: already rendered as links, nothing to place.
        /<[^>\s]+>/g,
    ]
    for (const re of passes) {
        const masked = chars.join('')
        let m: RegExpExecArray | null
        re.lastIndex = 0
        while ((m = re.exec(masked)) !== null) blank(chars, m.index, m.index + m[0].length)
    }

    // Links and images, label included. Blanking only the destination would
    // leave the label exposed, and `[https://x](https://x)` is exactly what an
    // auto-linkifier emits: replacing the label there empties the link and
    // leaves a card next to nothing.
    const link = /!?\[[^\]\n]*\]\([^)\n]*\)/g
    const masked = chars.join('')
    let m: RegExpExecArray | null
    while ((m = link.exec(masked)) !== null) blank(chars, m.index, m.index + m[0].length)

    return chars.join('')
}

// Every bare URL in the content, in document order, with the offsets of the text
// to replace. Repeats are kept: two occurrences are two pieces of text, and
// deduplicating would leave the second one sitting there as a raw URL.
export function findBareUrls(content: string): UrlMatch[] {
    if (!content) return []
    const masked = maskNonLinkRegions(content)
    const out: UrlMatch[] = []
    let m: RegExpExecArray | null
    BARE_URL.lastIndex = 0
    while ((m = BARE_URL.exec(masked)) !== null) {
        const url = m[0].replace(TRAILING, '')
        if (!url) continue
        out.push({ url, start: m.index, end: m.index + url.length })
    }
    return out
}
