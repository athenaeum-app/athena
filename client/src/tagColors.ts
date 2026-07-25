// Tag colour generation. The historical default is a vibrant random colour
// (`hsl(rand, ~70%, ~60%)`); this adds named presets that shift the HSL band
// so a library can lean pastel or muted. Purely client-side for now. A
// server-side bulk "regenerate all tag colours" write is a future item
// (PLAN 4.4); this module only feeds the "suggest a colour" affordance in the
// tag creator.

export type TagColorPreset = 'vibrant' | 'pastel' | 'muted'

export const TAG_COLOR_PRESETS: { id: TagColorPreset; label: string }[] = [
    { id: 'vibrant', label: 'Vibrant' },
    { id: 'pastel', label: 'Pastel' },
    { id: 'muted', label: 'Muted' },
]

// Saturation/lightness band per preset. Hue is always random across the wheel.
const BANDS: Record<TagColorPreset, { s: number; l: number }> = {
    vibrant: { s: 70, l: 60 },
    pastel: { s: 70, l: 82 },
    muted: { s: 35, l: 55 },
}

export function randomTagColor(preset: TagColorPreset = 'vibrant'): string {
    const { s, l } = BANDS[preset] ?? BANDS.vibrant
    const h = Math.floor(Math.random() * 360)
    return hslToHex(h, s, l)
}

// contrastingTextColor picks black or white for text drawn on a `bg` tag
// colour. A naive luminance>0.5 threshold (the previous approach) picks
// white for plenty of mid-brightness saturated colours, for example the default
// blue preset (#3b82f6), that only reach a 3.7:1 contrast ratio with white,
// short of the 4.5:1 WCAG AA floor. This instead compares the real contrast
// ratio against both black and white and returns whichever passes/wins.
function relLuminance(r: number, g: number, b: number): number {
    const chan = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

export function contrastingTextColor(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    const bgLum = relLuminance(r, g, b)
    const contrast = (lumA: number, lumB: number) => (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05)
    const withBlack = contrast(bgLum, 0)
    const withWhite = contrast(bgLum, 1)
    return withBlack >= withWhite ? '#000000' : '#ffffff'
}

// hslToHex converts HSL (h in [0,360), s/l in [0,100]) to a #rrggbb string,
// since the native color input and tag storage both use hex.
export function hslToHex(h: number, s: number, l: number): string {
    const sN = s / 100
    const lN = l / 100
    const c = (1 - Math.abs(2 * lN - 1)) * sN
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = lN - c / 2
    let r = 0
    let g = 0
    let b = 0
    if (h < 60) [r, g, b] = [c, x, 0]
    else if (h < 120) [r, g, b] = [x, c, 0]
    else if (h < 180) [r, g, b] = [0, c, x]
    else if (h < 240) [r, g, b] = [0, x, c]
    else if (h < 300) [r, g, b] = [x, 0, c]
    else [r, g, b] = [c, 0, x]
    const toHex = (v: number) =>
        Math.round((v + m) * 255)
            .toString(16)
            .padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
