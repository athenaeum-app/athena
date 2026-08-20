import { describe, it, expect } from 'vitest'
import type { ProjectDocument, ProjectDocumentComment } from './api'
import {
    blockFingerprint,
    childDocuments,
    documentBlocks,
    documentOutline,
    documentPath,
    documentStatusBadge,
    documentSubtree,
    documentThreads,
    documentWordCount,
    folderCounts,
    nextDocumentPosition,
    openThreadCount,
    readingMinutes,
    resolveDocumentAnchor,
} from './projectDocuments'

// The tree arrives flat, so every question the Documents tab asks of it is a
// function of that array (ADR-0020). These are those functions.

const row = (
    id: string,
    kind: 'folder' | 'document',
    parent: string | null,
    position: number,
    created = '2026-01-01T00:00:00Z',
): ProjectDocument => ({
    id,
    project_id: 'p1',
    parent_id: parent ?? undefined,
    kind,
    title: id,
    body: '',
    status: 'draft',
    position,
    open_comments: 0,
    created_at: created,
    updated_at: created,
})

// root
//   research/         (folder)
//     sources/        (folder)
//       one.md
//     notes.md
//   plan.md
const tree: ProjectDocument[] = [
    row('research', 'folder', null, 0),
    row('plan', 'document', null, 1),
    row('sources', 'folder', 'research', 0),
    row('notes', 'document', 'research', 1),
    row('one', 'document', 'sources', 0),
]

describe('childDocuments', () => {
    it('returns the root rows for a null parent, in position order', () => {
        expect(childDocuments(tree, null).map((d) => d.id)).toEqual(['research', 'plan'])
    })

    it('returns the direct children of a folder only', () => {
        expect(childDocuments(tree, 'research').map((d) => d.id)).toEqual(['sources', 'notes'])
    })

    it('keeps folders and documents in one order rather than clustering by kind', () => {
        const mixed = [row('b', 'document', null, 0), row('a', 'folder', null, 1)]
        expect(childDocuments(mixed, null).map((d) => d.id)).toEqual(['b', 'a'])
    })

    it('breaks a position tie on creation order', () => {
        const tied = [row('later', 'document', null, 0, '2026-02-01T00:00:00Z'), row('earlier', 'document', null, 0, '2026-01-01T00:00:00Z')]
        expect(childDocuments(tied, null).map((d) => d.id)).toEqual(['earlier', 'later'])
    })

    it('is empty for a folder nothing points at', () => {
        expect(childDocuments(tree, 'notes')).toEqual([])
    })
})

describe('nextDocumentPosition', () => {
    it('puts a new row after the last sibling', () => {
        expect(nextDocumentPosition(childDocuments(tree, null))).toBe(2)
    })

    it('starts at zero in an empty folder', () => {
        expect(nextDocumentPosition([])).toBe(0)
    })
})

describe('documentPath', () => {
    it('is empty at the tab root', () => {
        expect(documentPath(tree, null)).toEqual([])
    })

    it('names every ancestor, root first, ending with the row itself', () => {
        expect(documentPath(tree, 'one').map((d) => d.id)).toEqual(['research', 'sources', 'one'])
    })

    // A folder deleted in another tab: the breadcrumb collapses to the root
    // rather than naming something nobody can open.
    it('is empty for an id that is not in the tree', () => {
        expect(documentPath(tree, 'gone')).toEqual([])
    })

    it('stops rather than looping if a parent chain closes on itself', () => {
        const cycle = [row('a', 'folder', 'b', 0), row('b', 'folder', 'a', 0)]
        expect(documentPath(cycle, 'a').map((d) => d.id)).toEqual(['b', 'a'])
    })
})

describe('documentSubtree', () => {
    it('takes the row and everything under it, parents before children', () => {
        expect(documentSubtree(tree, 'research').map((d) => d.id)).toEqual(['research', 'sources', 'notes', 'one'])
    })

    it('is the row alone when it is a leaf', () => {
        expect(documentSubtree(tree, 'plan').map((d) => d.id)).toEqual(['plan'])
    })

    it('is empty for an unknown id', () => {
        expect(documentSubtree(tree, 'gone')).toEqual([])
    })

    // What the delete confirm counts: everything inside, at every depth.
    it('counts three items inside the research folder', () => {
        expect(documentSubtree(tree, 'research').length - 1).toBe(3)
    })
})

describe('folderCounts', () => {
    it('counts the direct children by kind', () => {
        expect(folderCounts(tree, 'research')).toEqual({ folders: 1, documents: 1 })
    })

    it('is zeroes for an empty folder', () => {
        expect(folderCounts(tree, 'plan')).toEqual({ folders: 0, documents: 0 })
    })
})

describe('documentOutline', () => {
    it('lists headings with their level, in source order', () => {
        expect(documentOutline('# One\n\ntext\n\n### Deep\n\n## Two')).toEqual([
            { level: 1, text: 'One' },
            { level: 3, text: 'Deep' },
            { level: 2, text: 'Two' },
        ])
    })

    it('strips markup a one-line entry has no room for', () => {
        expect(documentOutline('## The **big** `decision` ==here==')).toEqual([{ level: 2, text: 'The big decision here' }])
    })

    it('drops a closing run of hashes', () => {
        expect(documentOutline('## Balanced ##')).toEqual([{ level: 2, text: 'Balanced' }])
    })

    it('reduces a link to its text', () => {
        expect(documentOutline('# See [the ADR](https://example.com)')).toEqual([{ level: 1, text: 'See the ADR' }])
    })

    // A `# comment` in a shell sample is code. Offering to scroll to it would
    // point at a heading the renderer never drew.
    it('skips headings inside a fenced code block', () => {
        expect(documentOutline('# Real\n\n```bash\n# not a heading\n```\n\n## Also real')).toEqual([
            { level: 1, text: 'Real' },
            { level: 2, text: 'Also real' },
        ])
    })

    it('skips headings inside a tilde fence', () => {
        expect(documentOutline('~~~\n# hidden\n~~~')).toEqual([])
    })

    it('treats an unclosed fence as running to the end, the way markdown reads it', () => {
        expect(documentOutline('```\n# hidden\n\n## also hidden')).toEqual([])
    })

    it('ignores a hash with no space after it, which is not a heading', () => {
        expect(documentOutline('#tag not a heading')).toEqual([])
    })

    it('ignores a run of seven hashes, which is past the maximum level', () => {
        expect(documentOutline('####### too deep')).toEqual([])
    })

    it('drops a heading that is only markup', () => {
        expect(documentOutline('## **')).toEqual([])
    })

    it('is empty for a document with no headings', () => {
        expect(documentOutline('just prose\n\nand more of it')).toEqual([])
    })
})

describe('documentWordCount', () => {
    it('counts words of prose', () => {
        expect(documentWordCount('one two three')).toBe(3)
    })

    it('does not count an embed token as a word', () => {
        expect(documentWordCount('before ::doc:abc123:: after')).toBe(2)
        expect(documentWordCount('before [[abc123]] after')).toBe(2)
    })

    it('counts a link by its text, not its target', () => {
        expect(documentWordCount('read [the docs](https://example.com/very/long/path)')).toBe(3)
    })

    it('does not count bullets, rules or empty lines', () => {
        expect(documentWordCount('- one\n- two\n\n---\n')).toBe(2)
    })

    it('is zero for an empty body', () => {
        expect(documentWordCount('')).toBe(0)
    })
})

describe('readingMinutes', () => {
    it('is zero only for an empty document', () => {
        expect(readingMinutes(0)).toBe(0)
    })

    it('never rounds a short document down to nothing', () => {
        expect(readingMinutes(12)).toBe(1)
    })

    it('is the word count over two hundred a minute', () => {
        expect(readingMinutes(600)).toBe(3)
    })
})

// ---- blocks and comment anchors ----

// A comment hangs off a block, so what counts as a block is the whole of what a
// comment can point at. The body is rewritten whole on every save, which is why
// none of this can be an offset.

describe('documentBlocks', () => {
    it('splits on blank lines and numbers the blocks in source order', () => {
        const blocks = documentBlocks('# Why SQLite\n\nIt ships inside the binary.\n\nOne file, one backup.')
        expect(blocks.map((b) => b.index)).toEqual([0, 1, 2])
        expect(blocks[0].text).toBe('# Why SQLite')
        expect(blocks[2].text).toBe('One file, one backup.')
    })

    it('keeps a fenced code block whole, blank lines and all', () => {
        const blocks = documentBlocks('Before.\n\n```go\nfunc main() {\n\n}\n```\n\nAfter.')
        expect(blocks).toHaveLength(3)
        expect(blocks[1].text).toBe('```go\nfunc main() {\n\n}\n```')
    })

    it('keeps a loose list as one block, so an ordered list does not restart', () => {
        const blocks = documentBlocks('1. First\n\n2. Second\n\n3. Third')
        expect(blocks).toHaveLength(1)
        expect(blocks[0].text.split('\n').filter(Boolean)).toHaveLength(3)
    })

    it('keeps a multi-paragraph blockquote as one block', () => {
        const blocks = documentBlocks('> One thing.\n>\n> And another.\n\nOutside.')
        expect(blocks).toHaveLength(2)
        expect(blocks[1].text).toBe('Outside.')
    })

    it('is empty for an empty body', () => {
        expect(documentBlocks('')).toEqual([])
        expect(documentBlocks('\n\n  \n')).toEqual([])
    })
})

describe('blockFingerprint', () => {
    it('reduces a block to the words a reader sees', () => {
        expect(blockFingerprint('## Why **SQLite**')).toBe('why sqlite')
        expect(blockFingerprint('- read [the docs](https://example.com/x)')).toBe('read the docs')
        expect(blockFingerprint('The reasoning is in ::doc:abc123::')).toBe('the reasoning is in')
    })

    it('is empty for a block with no words of its own', () => {
        expect(blockFingerprint('::doc:abc123::')).toBe('')
        expect(blockFingerprint('---')).toBe('')
    })
})

const anchor = (index: number, text: string) => ({ anchor_index: index, anchor_text: text })

describe('resolveDocumentAnchor', () => {
    const body = '# Why SQLite\n\nIt ships inside the binary, so there is nothing to install.\n\nOne file, one backup.'
    const blocks = documentBlocks(body)

    it('matches when the fingerprint and the index still agree', () => {
        expect(resolveDocumentAnchor(blocks, anchor(1, blocks[1].fingerprint))).toEqual({ index: 1, match: 'exact' })
    })

    it('follows the text when an edit above it moved the block', () => {
        const moved = documentBlocks('A new opening paragraph.\n\n' + body)
        expect(resolveDocumentAnchor(moved, anchor(1, blocks[1].fingerprint))).toEqual({ index: 2, match: 'moved' })
    })

    it('picks the nearest of several identical blocks', () => {
        const repeated = documentBlocks('Yes.\n\nSomething else.\n\nYes.\n\nAnd more.\n\nYes.')
        expect(resolveDocumentAnchor(repeated, anchor(3, 'yes.'))).toEqual({ index: 2, match: 'moved' })
    })

    it('falls back to the index when the block was rewritten in place', () => {
        const edited = documentBlocks('# Why SQLite\n\nIt ships inside the binary, so deployment is a file copy.\n\nOne file, one backup.')
        expect(resolveDocumentAnchor(edited, anchor(1, blocks[1].fingerprint))).toEqual({ index: 1, match: 'edited' })
    })

    it('orphans the comment rather than moving it onto an unrelated block', () => {
        const rewritten = documentBlocks('# Why SQLite\n\nPostgres would need a second process to babysit.\n\nOne file, one backup.')
        expect(resolveDocumentAnchor(rewritten, anchor(1, blocks[1].fingerprint))).toEqual({ index: null, match: 'orphaned' })
    })

    it('orphans a comment whose block was deleted outright', () => {
        expect(resolveDocumentAnchor(documentBlocks('# Why SQLite'), anchor(1, blocks[1].fingerprint))).toEqual({
            index: null,
            match: 'orphaned',
        })
    })

    it('holds a wordless block by its index alone, and only while it stays wordless', () => {
        const embeds = documentBlocks('::doc:abc123::\n\n::doc:def456::')
        expect(resolveDocumentAnchor(embeds, anchor(1, ''))).toEqual({ index: 1, match: 'exact' })
        expect(resolveDocumentAnchor(documentBlocks('::doc:abc123::\n\nWords now.'), anchor(1, ''))).toEqual({
            index: null,
            match: 'orphaned',
        })
    })
})

const comment = (id: string, overrides: Partial<ProjectDocumentComment> = {}): ProjectDocumentComment => ({
    id,
    document_id: 'd1',
    anchor_index: 0,
    anchor_text: '',
    body: id,
    resolved: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
})

describe('documentThreads', () => {
    const blocks = documentBlocks('# Why SQLite\n\nIt ships inside the binary.\n\nOne file, one backup.')

    it('groups replies under their thread in the order they were written', () => {
        const threads = documentThreads(
            [
                comment('root', { anchor_index: 1, anchor_text: blocks[1].fingerprint }),
                comment('second', { parent_id: 'root', created_at: '2026-01-03T00:00:00Z' }),
                comment('first', { parent_id: 'root', created_at: '2026-01-02T00:00:00Z' }),
            ],
            blocks,
        )
        expect(threads).toHaveLength(1)
        expect(threads[0].replies.map((r) => r.id)).toEqual(['first', 'second'])
        expect(threads[0].at).toEqual({ index: 1, match: 'exact' })
    })

    it('reads down the document, with the orphans after everything that landed', () => {
        const threads = documentThreads(
            [
                comment('orphan', { anchor_index: 1, anchor_text: 'a paragraph nobody kept' }),
                comment('last', { anchor_index: 2, anchor_text: blocks[2].fingerprint }),
                comment('first', { anchor_index: 0, anchor_text: blocks[0].fingerprint }),
            ],
            blocks,
        )
        expect(threads.map((t) => t.root.id)).toEqual(['first', 'last', 'orphan'])
        expect(threads[2].at.match).toBe('orphaned')
    })

    it('counts open threads, not comments: a reply is part of the thread above it', () => {
        const threads = documentThreads(
            [
                comment('open'),
                comment('reply', { parent_id: 'open' }),
                comment('settled', { anchor_index: 2, anchor_text: blocks[2].fingerprint, resolved: true }),
            ],
            blocks,
        )
        expect(openThreadCount(threads)).toBe(1)
    })
})

describe('documentStatusBadge', () => {
    it('draws nothing for a draft, since every document starts there', () => {
        expect(documentStatusBadge('draft')).toBeNull()
    })

    it('names the two states worth spotting from the grid', () => {
        expect(documentStatusBadge('final')?.label).toBe('Final')
        expect(documentStatusBadge('locked')?.label).toBe('Locked')
    })
})
