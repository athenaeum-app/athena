// Which modal owns Escape: the last one opened, by mount order rather than by
// z-index.
//
// Every modal used to run its own capture-phase listener and ask the DOM
// whether some other known modal happened to be open
// ([data-editor-menu], [data-card-modal], [data-confirm-modal]), so opening a
// new kind of modal meant editing every existing query, and forgetting one
// closed two layers on a single key. Mount order answers the same question
// without anyone having to enumerate their neighbours.
const stack: symbol[] = []

export function pushModal(): symbol {
    const token = Symbol('modal')
    stack.push(token)
    return token
}

export function popModal(token: symbol): void {
    const i = stack.lastIndexOf(token)
    if (i >= 0) stack.splice(i, 1)
}

export function isTopModal(token: symbol): boolean {
    return stack.length > 0 && stack[stack.length - 1] === token
}

export function openModalCount(): number {
    return stack.length
}
