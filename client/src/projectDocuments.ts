import type { ProjectDocument, ProjectDocumentComment, ProjectDocumentStatus } from './api'
import { stripEmbedTokens } from './components/MomentBody'
import { stripInlineFormatting } from './markdownFormatting'

// The pure half of the Documents tab (ADR-0020): tree shape, breadcrumbs,
// outline and word count. The project payload carries the whole tree flat, so
// every question the tab asks ("what is in this folder", "how do I get back to
// the root", "how much does this delete take") is a function of that array and
// belongs here rather than inside a component that cannot be tested.

// One folder's direct children, in the order the tab draws them. Folders and
// documents share the ordering rather than clustering by kind: position is the
// author's arrangement and splitting it in two would override them.
export function childDocuments(documents: readonly ProjectDocument[], parentId: string | null): ProjectDocument[] {
    return documents
        .filter((d) => (d.parent_id || null) === parentId)
        .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
}

// Where a new sibling goes: after the last one. Same idiom the board uses for a
// card dropped at the end of a milestone, so positions stay REAL and an insert
// between two rows never has to renumber anything.
export function nextDocumentPosition(siblings: readonly ProjectDocument[]): number {
    return siblings.length ? siblings[siblings.length - 1].position + 1 : 0
}

// The breadcrumb: every ancestor of `id`, root first, ending with the row
// itself. An id that is not in the tree gives an empty path, which is how a
// folder deleted in another tab lands the reader back at the root rather than
// on a blank grid. Guarded against a parent cycle the server should never
// produce but which would otherwise hang the render.
export function documentPath(documents: readonly ProjectDocument[], id: string | null): ProjectDocument[] {
    const byId = new Map(documents.map((d) => [d.id, d]))
    const path: ProjectDocument[] = []
    const seen = new Set<string>()
    let at = id
    while (at && !seen.has(at)) {
        seen.add(at)
        const row = byId.get(at)
        if (!row) return []
        path.unshift(row)
        at = row.parent_id || null
    }
    return path
}

// A row and everything under it, parents first: the shape the server's delete
// answers with, computed locally so the confirm can state the count before
// anything is destroyed.
export function documentSubtree(documents: readonly ProjectDocument[], id: string): ProjectDocument[] {
    const root = documents.find((d) => d.id === id)
    if (!root) return []
    const out = [root]
    for (let i = 0; i < out.length; i++) {
        out.push(...childDocuments(documents, out[i].id))
    }
    return out
}

// What a folder tile reports: its direct children, counted by kind. Direct
// rather than recursive, so the number matches what opening the folder shows.
export function folderCounts(
    documents: readonly ProjectDocument[],
    folderId: string,
): { folders: number; documents: number } {
    const children = childDocuments(documents, folderId)
    return {
        folders: children.filter((d) => d.kind === 'folder').length,
        documents: children.filter((d) => d.kind === 'document').length,
    }
}

// ---- status ----

// What a tile puts next to a title. Draft is where every document starts, so a
// badge for it would sit on every tile in the grid saying nothing; Final and
// Locked are the two worth spotting without opening anything.
export function documentStatusBadge(status: ProjectDocumentStatus): { label: string; icon: string } | null {
    if (status === 'final') return { label: 'Final', icon: 'task_alt' }
    if (status === 'locked') return { label: 'Locked', icon: 'lock' }
    return null
}

// ---- outline ----

export interface DocumentHeading {
    // 1 to 6, as written.
    level: number
    text: string
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/

// A heading's plain text: the markup an outline entry has no room for is
// dropped, the same way an excerpt drops it.
function headingText(raw: string): string {
    return stripInlineFormatting(stripEmbedTokens(raw.replace(/[ \t]+#+[ \t]*$/, '')))
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// Every ATX heading in a document body, in source order, skipping anything
// inside a fenced code block: a `# comment` in a shell sample is code, and
// listing it in the outline would offer to scroll to a heading that was never
// rendered as one. Setext headings are deliberately out: the tab's own composer
// writes ATX, and a line of dashes under a paragraph is far more often a
// thematic break in practice.
//
// The index of an entry is the index of its rendered heading element, which is
// how the sidebar scrolls to it without the renderer having to mint anchor ids.
export function documentOutline(body: string): DocumentHeading[] {
    const out: DocumentHeading[] = []
    let fence: string | null = null
    for (const line of (body || '').split('\n')) {
        const opener = FENCE.exec(line)
        if (fence) {
            if (
                opener &&
                opener[1][0] === fence[0] &&
                opener[1].length >= fence.length &&
                line.slice(opener[0].length).trim() === ''
            ) {
                fence = null
            }
            continue
        }
        if (opener) {
            fence = opener[1]
            continue
        }
        const heading = ATX_HEADING.exec(line)
        if (!heading) continue
        const text = headingText(heading[2])
        if (text) out.push({ level: heading[1].length, text })
    }
    return out
}

// ---- blocks and comment anchors ----

export interface DocumentBlock {
    // Position in source order, counted from 0. This is what an anchor stores
    // as its fallback.
    index: number
    // The block's markdown exactly as written, which is what gets rendered.
    text: string
    // Normalized plain text, truncated: what an anchor stores to recognize the
    // block again.
    fingerprint: string
}

// How much of a block an anchor remembers. Long enough to tell two paragraphs
// apart, short enough that rewriting the tail of a long block does not lose the
// anchor. The server truncates too, at a higher cap, as a backstop.
export const ANCHOR_FINGERPRINT_LENGTH = 120

// A prefix this long shared by two blocks means the same block, edited: a
// coincidence that long between different paragraphs of one document is not
// worth designing around.
const ANCHOR_PREFIX_MATCH = 16

// And below this share of words in common, two blocks are different blocks.
const ANCHOR_WORD_OVERLAP = 0.5

const LIST_ITEM = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/
const QUOTE = /^[ \t]{0,3}>/
const INDENTED = /^[ \t]{2,}\S/
const BLANK = /^[ \t]*$/

// A comment anchors to a block, never to a character range: the whole body is
// rewritten on every save, so an offset pair would be stale the moment a word
// was added above it. A block is what a reader would point at: a paragraph, a
// heading, a list, a fenced code sample.
//
// Blank lines separate blocks, with two exceptions that would otherwise split
// one thing into several: a loose list (blank lines between its items, which
// would restart an ordered list's numbering) and a multi-paragraph blockquote.
// Blank lines inside a fence are content, not separators.
export function documentBlocks(body: string): DocumentBlock[] {
    const blocks: DocumentBlock[] = []
    let current: string[] = []
    let pendingBlanks: string[] = []
    let fence: string | null = null

    const flush = () => {
        if (!current.length) return
        const text = current.join('\n')
        blocks.push({ index: blocks.length, text, fingerprint: blockFingerprint(text) })
        current = []
    }

    for (const line of (body || '').split('\n')) {
        if (fence) {
            current.push(line)
            const closer = FENCE.exec(line)
            if (closer && closer[1][0] === fence[0] && closer[1].length >= fence.length && line.slice(closer[0].length).trim() === '') {
                fence = null
            }
            continue
        }
        if (BLANK.test(line)) {
            if (current.length) pendingBlanks.push(line)
            continue
        }
        if (pendingBlanks.length) {
            if (continuesBlock(current[0], line)) current.push(...pendingBlanks)
            else flush()
            pendingBlanks = []
        }
        current.push(line)
        const opener = FENCE.exec(line)
        if (opener) fence = opener[1]
    }
    flush()
    return blocks
}

// Whether a line after a blank one carries on the block it follows rather than
// starting a new one.
function continuesBlock(first: string, line: string): boolean {
    if (!first) return false
    if (LIST_ITEM.test(first)) return LIST_ITEM.test(line) || INDENTED.test(line)
    if (QUOTE.test(first)) return QUOTE.test(line)
    return false
}

// A block reduced to the words a reader sees: markup, embed tokens, link and
// image targets and list markers all go, since none of them is what the comment
// was about and all of them change under edits that leave the sentence alone.
export function blockFingerprint(markdown: string): string {
    return stripInlineFormatting(stripEmbedTokens(markdown || ''))
        .replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, '')
        .replace(/[#>*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .slice(0, ANCHOR_FINGERPRINT_LENGTH)
}

// How well an anchor found its block:
//   exact    both the fingerprint and the index still agree
//   moved    the same text, at a different index (something above it changed)
//   edited   the block at the stored index is recognizably the same, rewritten
//   orphaned neither: the block it was about is gone
export type AnchorMatch = 'exact' | 'moved' | 'edited' | 'orphaned'

export interface AnchorResolution {
    // The block the comment belongs against, or null when orphaned.
    index: number | null
    match: AnchorMatch
}

export interface DocumentAnchor {
    anchor_index: number
    anchor_text: string
}

// Resolve an anchor against the document as it now reads. Fingerprint first,
// index second, and an explicit orphan when neither holds: silently hanging a
// remark on whatever happens to sit at that index now is worse than admitting
// the block it was about is gone.
export function resolveDocumentAnchor(blocks: readonly DocumentBlock[], anchor: DocumentAnchor): AnchorResolution {
    const at = anchor.anchor_index
    const wanted = anchor.anchor_text
    const here = at >= 0 && at < blocks.length ? blocks[at] : null

    // A block with no words of its own (a lone embed, a rule, an image) has no
    // fingerprint to match, so the index is all there is. It only holds if what
    // is there now is equally wordless.
    if (!wanted) return here && !here.fingerprint ? { index: at, match: 'exact' } : { index: null, match: 'orphaned' }

    if (here && here.fingerprint === wanted) return { index: at, match: 'exact' }

    // Identical blocks are legal (two paragraphs reading "Yes."), so the
    // nearest one to where the comment was left is the best guess available.
    let nearest: number | null = null
    for (const block of blocks) {
        if (block.fingerprint !== wanted) continue
        if (nearest === null || Math.abs(block.index - at) < Math.abs(nearest - at)) nearest = block.index
    }
    if (nearest !== null) return { index: nearest, match: 'moved' }

    if (here && similarFingerprint(here.fingerprint, wanted)) return { index: at, match: 'edited' }
    return { index: null, match: 'orphaned' }
}

// A thread and where it landed: the remark, its replies oldest first, and the
// block it resolves against in the document as it now reads.
export interface DocumentThread {
    root: ProjectDocumentComment
    replies: ProjectDocumentComment[]
    at: AnchorResolution
}

// Orphaned threads sort to the end. MAX_SAFE_INTEGER rather than Infinity
// because two orphans subtracted from each other have to give a number.
const THREAD_ORDER_LAST = Number.MAX_SAFE_INTEGER

// Group a document's flat comment list into threads and resolve each one
// against the body. Reading order, so the panel and the margin markers agree
// on which thread comes first, with the orphans after everything that landed.
export function documentThreads(
    comments: readonly ProjectDocumentComment[],
    blocks: readonly DocumentBlock[],
): DocumentThread[] {
    return comments
        .filter((c) => !c.parent_id)
        .map((root) => ({
            root,
            replies: comments.filter((c) => c.parent_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
            at: resolveDocumentAnchor(blocks, root),
        }))
        .sort(
            (a, b) =>
                (a.at.index ?? THREAD_ORDER_LAST) - (b.at.index ?? THREAD_ORDER_LAST) ||
                a.root.created_at.localeCompare(b.root.created_at),
        )
}

export const openThreadCount = (threads: readonly DocumentThread[]): number => threads.filter((t) => !t.root.resolved).length

function similarFingerprint(a: string, b: string): boolean {
    if (!a || !b) return false
    let shared = 0
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
    if (shared >= ANCHOR_PREFIX_MATCH) return true
    const left = new Set(a.split(' ').filter(Boolean))
    const right = new Set(b.split(' ').filter(Boolean))
    if (!left.size || !right.size) return false
    let common = 0
    for (const word of left) if (right.has(word)) common++
    return common / (left.size + right.size - common) >= ANCHOR_WORD_OVERLAP
}

// ---- size ----

// Words as a reader counts them: embed tokens are entities rather than prose,
// image and link targets are addresses, and a run has to carry a letter or a
// digit to be a word at all (a lone bullet or a row of dashes is not).
export function documentWordCount(body: string): number {
    const text = stripEmbedTokens(body || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length
}

// 200 words a minute, rounded up, so a document that has anything in it never
// reads as taking no time.
export function readingMinutes(words: number): number {
    return words === 0 ? 0 : Math.max(1, Math.round(words / 200))
}
