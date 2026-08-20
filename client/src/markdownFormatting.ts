import { markdownLineEnding } from 'micromark-util-character'
import { splice } from 'micromark-util-chunked'
import { classifyCharacter } from 'micromark-util-classify-character'
import { resolveAll } from 'micromark-util-resolve-all'
import type {
    Code,
    Construct,
    Effects,
    Event,
    Extension,
    HtmlExtension,
    State,
    Token,
    TokenType,
    TokenizeContext,
} from 'micromark-util-types'

// Inline rich formatting for the shared markdown pipeline (MarkdownText), on
// top of micromark + GFM:
//
//     ==text==              highlighted, as a <mark>
//     ++text++              underlined
//     [text]{color=NAME}    drawn in one of the preset colours
//
// A micromark syntax extension rather than a pre-transform of the source: the
// renderer is the only thing that knows where a code span ends, so a rewrite
// done before it would put markup inside fenced code, and one done after it
// would mean injecting author-controlled HTML into a multi-user app. Written as
// an extension, `==**bold**==` composes for free and a `==` inside code is left
// alone by construction.
//
// The syntax is a data format: content already written is stored as this text,
// so the markers are fixed and only the rendering they map to is ours to
// choose.

declare module 'micromark-util-types' {
    interface TokenTypeMap {
        mdMark: 'mdMark'
        mdMarkText: 'mdMarkText'
        mdMarkSequence: 'mdMarkSequence'
        mdMarkSequenceTemporary: 'mdMarkSequenceTemporary'
        mdUnderline: 'mdUnderline'
        mdUnderlineText: 'mdUnderlineText'
        mdUnderlineSequence: 'mdUnderlineSequence'
        mdUnderlineSequenceTemporary: 'mdUnderlineSequenceTemporary'
        mdColor: 'mdColor'
        mdColorMarker: 'mdColorMarker'
        mdColorText: 'mdColorText'
        mdColorAttribute: 'mdColorAttribute'
        mdColorName: 'mdColorName'
    }
}

// The preset palette. A closed set on purpose: the name lands in a class name,
// and a free-form colour from the author would be both an unbounded stylesheet
// and a way to write CSS into someone else's page.
export const INLINE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

export type InlineColor = (typeof INLINE_COLORS)[number]

const COLOR_NAMES = new Set<string>(INLINE_COLORS)

const EQUALS = 61
const PLUS = 43
const LEFT_BRACKET = 91
const RIGHT_BRACKET = 93
const LEFT_BRACE = 123
const RIGHT_BRACE = 125

// The attribute that carries the colour. Spelled out here so the tokenizer and
// the toolbar that writes it cannot drift apart.
const COLOR_ATTRIBUTE = 'color='

interface PairTypes {
    marker: number
    // The whole span, the tag is written from this one.
    whole: TokenType
    // What sits between the two sequences.
    text: TokenType
    sequence: TokenType
    // The sequence before it is known whether it opens or closes anything.
    temporary: TokenType
}

// A paired-marker span (`==x==`, `++x++`), resolved the way GFM strikethrough
// resolves `~~x~~`: the sequences are tokenized as they are met and paired up
// afterwards, which is what lets the content between them stay ordinary
// markdown instead of a flat run of characters.
function pairConstruct(types: PairTypes): Construct {
    const construct: Construct = {
        name: String(types.whole),
        tokenize: tokenizePair,
        resolveAll: resolveAllPairs,
    }
    return construct

    function resolveAllPairs(events: Event[], context: TokenizeContext): Event[] {
        let index = -1

        while (++index < events.length) {
            if (events[index][0] === 'enter' && events[index][1].type === types.temporary && events[index][1]._close) {
                let open = index

                while (open--) {
                    if (
                        events[open][0] === 'exit' &&
                        events[open][1].type === types.temporary &&
                        events[open][1]._open &&
                        events[index][1].end.offset - events[index][1].start.offset ===
                            events[open][1].end.offset - events[open][1].start.offset
                    ) {
                        events[index][1].type = types.sequence
                        events[open][1].type = types.sequence

                        const whole: Token = {
                            type: types.whole,
                            start: Object.assign({}, events[open][1].start),
                            end: Object.assign({}, events[index][1].end),
                        }
                        const text: Token = {
                            type: types.text,
                            start: Object.assign({}, events[open][1].end),
                            end: Object.assign({}, events[index][1].start),
                        }

                        const nextEvents: Event[] = [
                            ['enter', whole, context],
                            ['enter', events[open][1], context],
                            ['exit', events[open][1], context],
                            ['enter', text, context],
                        ]
                        const insideSpan = context.parser.constructs.insideSpan.null
                        if (insideSpan) {
                            splice(
                                nextEvents,
                                nextEvents.length,
                                0,
                                resolveAll(insideSpan, events.slice(open + 1, index), context),
                            )
                        }
                        splice(nextEvents, nextEvents.length, 0, [
                            ['exit', text, context],
                            ['enter', events[index][1], context],
                            ['exit', events[index][1], context],
                            ['exit', whole, context],
                        ])
                        splice(events, open - 1, index - open + 3, nextEvents)
                        index = open + nextEvents.length - 2
                        break
                    }
                }
            }
        }

        // Sequences that never found a partner are just text.
        index = -1
        while (++index < events.length) {
            if (events[index][1].type === types.temporary) events[index][1].type = 'data'
        }
        return events
    }

    function tokenizePair(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
        const previous = this.previous
        const events = this.events
        let size = 0

        return start

        function start(code: Code): State | undefined {
            if (previous === types.marker && events[events.length - 1][1].type !== 'characterEscape') {
                return nok(code)
            }
            effects.enter(types.temporary)
            return more(code)
        }

        function more(code: Code): State | undefined {
            const before = classifyCharacter(previous)
            if (code === types.marker) {
                // A third marker in a row is the author writing markers, not a
                // span: `===` is left alone.
                if (size > 1) return nok(code)
                effects.consume(code)
                size++
                return more
            }
            // A single marker means nothing here, unlike GFM's single tilde.
            if (size < 2) return nok(code)
            const token = effects.exit(types.temporary)
            const after = classifyCharacter(code)
            token._open = !after || (after === 2 && Boolean(before))
            token._close = !before || (before === 2 && Boolean(after))
            return ok(code)
        }
    }
}

// `[text]{color=NAME}`. Consumed in one pass rather than resolved from paired
// markers, because the closing half carries a value: the span is only a colour
// if the attribute is there and names a preset, and anything else has to fall
// back to whatever markdown would have made of `[text]` on its own.
const colorConstruct: Construct = {
    name: 'mdColor',
    tokenize: tokenizeColor,
}

function tokenizeColor(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    // Brackets nest so a markdown link can sit inside a coloured span; the
    // label ends at the `]` that closes the one this construct opened.
    let depth = 0
    let size = 0
    let attributeIndex = 0
    let name = ''

    return start

    function start(code: Code): State | undefined {
        effects.enter('mdColor')
        effects.enter('mdColorMarker')
        effects.consume(code)
        effects.exit('mdColorMarker')
        effects.enter('mdColorText')
        // The label is markdown in its own right, so it goes back through the
        // text tokenizer rather than being consumed as flat characters.
        effects.enter('chunkText', { contentType: 'text' })
        return inside
    }

    function inside(code: Code): State | undefined {
        // A span that runs off the end of a line is far more likely to be a
        // stray bracket than an intentional one.
        if (code === null || markdownLineEnding(code)) return nok(code)
        if (code === LEFT_BRACKET) depth++
        if (code === RIGHT_BRACKET) {
            if (depth === 0) {
                if (size === 0) return nok(code)
                effects.exit('chunkText')
                effects.exit('mdColorText')
                effects.enter('mdColorMarker')
                effects.consume(code)
                effects.exit('mdColorMarker')
                return afterLabel
            }
            depth--
        }
        effects.consume(code)
        size++
        return inside
    }

    function afterLabel(code: Code): State | undefined {
        if (code !== LEFT_BRACE) return nok(code)
        effects.enter('mdColorMarker')
        effects.consume(code)
        effects.exit('mdColorMarker')
        effects.enter('mdColorAttribute')
        return attribute
    }

    function attribute(code: Code): State | undefined {
        if (attributeIndex === COLOR_ATTRIBUTE.length) {
            effects.exit('mdColorAttribute')
            effects.enter('mdColorName')
            return colorName(code)
        }
        if (code !== COLOR_ATTRIBUTE.charCodeAt(attributeIndex)) return nok(code)
        effects.consume(code)
        attributeIndex++
        return attribute
    }

    function colorName(code: Code): State | undefined {
        // a-z only: the name becomes part of a class name, so nothing else is
        // ever let through.
        if (code !== null && code >= 97 && code <= 122) {
            name += String.fromCharCode(code)
            effects.consume(code)
            return colorName
        }
        if (code !== RIGHT_BRACE || !COLOR_NAMES.has(name)) return nok(code)
        effects.exit('mdColorName')
        effects.enter('mdColorMarker')
        effects.consume(code)
        effects.exit('mdColorMarker')
        effects.exit('mdColor')
        return ok
    }
}

const markConstruct = pairConstruct({
    marker: EQUALS,
    whole: 'mdMark',
    text: 'mdMarkText',
    sequence: 'mdMarkSequence',
    temporary: 'mdMarkSequenceTemporary',
})

const underlineConstruct = pairConstruct({
    marker: PLUS,
    whole: 'mdUnderline',
    text: 'mdUnderlineText',
    sequence: 'mdUnderlineSequence',
    temporary: 'mdUnderlineSequenceTemporary',
})

// Syntax half of the extension, for micromark's `extensions`.
export function inlineFormatting(): Extension {
    return {
        text: {
            [EQUALS]: markConstruct,
            [PLUS]: underlineConstruct,
            [LEFT_BRACKET]: colorConstruct,
        },
        insideSpan: { null: [markConstruct, underlineConstruct] },
        // Tells emphasis that these characters are markers, so it classifies
        // the characters around them the way it does around `~` and `*`.
        attentionMarkers: { null: [EQUALS, PLUS] },
    }
}

// HTML half, for micromark's `htmlExtensions`. Classes rather than inline
// styles: the palette has to answer to the active Theme, and only the
// stylesheet knows what that is.
export function inlineFormattingHtml(): HtmlExtension {
    // The colour is written after the text it applies to, so the text is
    // buffered until the name is known. Stacks because a coloured span can sit
    // inside another one's label.
    const names: string[] = []
    const bodies: string[] = []

    return {
        enter: {
            mdMark() {
                this.tag('<mark class="md-mark">')
            },
            mdUnderline() {
                this.tag('<span class="md-underline">')
            },
            mdColorText() {
                this.buffer()
            },
        },
        exit: {
            mdMark() {
                this.tag('</mark>')
            },
            mdUnderline() {
                this.tag('</span>')
            },
            mdColorText() {
                bodies.push(this.resume())
            },
            mdColorName(token) {
                names.push(this.sliceSerialize(token))
            },
            mdColor() {
                const body = bodies.pop() ?? ''
                const name = names.pop() ?? ''
                // Two classes: one carries the shared treatment, the other only
                // names the hue, so the stylesheet states the mix once.
                this.tag(`<span class="md-color md-color-${name}">`)
                this.raw(body)
                this.tag('</span>')
            },
        },
    }
}

// The same three spans as source text, for anything that flattens markdown to
// plain text (a moment excerpt) instead of rendering it.
export function stripInlineFormatting(text: string): string {
    return text
        .replace(/\[([^\]]*)\]\{color=[a-z]+\}/g, '$1')
        .replace(/==([^=]+)==/g, '$1')
        .replace(/\+\+([^+]+)\+\+/g, '$1')
}

// What the composer's toolbar wraps a selection in. Kept beside the parser so
// the two halves of the syntax are written once.
export const MARK_SYNTAX = { prefix: '==', suffix: '==' }
export const UNDERLINE_SYNTAX = { prefix: '++', suffix: '++' }
export const colorSyntax = (color: InlineColor) => ({ prefix: '[', suffix: `]{${COLOR_ATTRIBUTE}${color}}` })
