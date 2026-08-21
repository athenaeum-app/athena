// Putting text on the clipboard from a page that may not be in a secure
// context.
//
// navigator.clipboard is defined only on https and localhost. Athena is
// self-hosted, and serving it over plain http on a LAN address is a normal way
// to run it, so on a lot of real installs the object is not merely refused but
// absent: `navigator.clipboard.writeText(...)` throws a TypeError instead of
// returning a promise, which means a .catch() hung on the call never runs and
// the button appears to do nothing at all.
//
// document.execCommand('copy') is deprecated and still the only thing that
// works there, so it is the fallback rather than the first choice.
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // Denied, or a permission prompt was dismissed. The fallback below can
        // still work, because it rides on a user gesture rather than a
        // permission.
    }
    return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
    if (typeof document === 'undefined' || !document.body) return false
    const area = document.createElement('textarea')
    area.value = text
    // Off-screen rather than hidden: execCommand copies the selection, and
    // there is no selection to make inside display:none. readOnly keeps the
    // mobile keyboard down, and the fixed position stops the page jumping to
    // it while it is briefly focused.
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    try {
        area.select()
        area.setSelectionRange(0, text.length)
        return document.execCommand('copy')
    } catch {
        return false
    } finally {
        area.remove()
    }
}
