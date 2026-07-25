import { Show, createUniqueId, type Component, type JSX } from 'solid-js'

// A text/password field with a hairline border and corner brackets that
// draw in on focus, instead of the generic "border recolors on focus"
// treatment. Shared by every entry surface (setup / login / register) so
// they read as one family. Extracted from Setup.tsx.
//
// The label is tied to its input with a generated id, so clicking the label
// focuses the field and screen readers announce the two together. Generated
// rather than derived from the label text, because the same label can appear
// twice on screen (two password fields in the account form) and duplicate ids
// would send both clicks to the first one.
export const FormField: Component<{
    label: string
    type: string
    value: string
    onInput: (value: string) => void
    required?: boolean
    autofocus?: boolean
    placeholder?: string
    // Optional muted hint rendered after the label (e.g. "not needed for
    // the first user").
    hint?: JSX.Element
}> = (props) => {
    const id = createUniqueId()
    return (
    <div>
        <label for={id} class="text-sub mb-1.5 block text-xs font-medium">
            {props.label}
            <Show when={props.hint}>
                <span class="ml-1 opacity-60">{props.hint}</span>
            </Show>
        </label>
        <div class="group relative">
            <input
                id={id}
                type={props.type}
                value={props.value}
                onInput={(e) => props.onInput(e.currentTarget.value)}
                placeholder={props.placeholder}
                class="bg-element text-main border-element-accent w-full rounded-sm border px-3 py-2 focus:outline-none"
                required={props.required}
                autofocus={props.autofocus}
            />
            <span class="border-highlight-strongest pointer-events-none absolute -top-px -left-px h-2.5 w-2.5 border-t-2 border-l-2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100" />
            <span class="border-highlight-strongest pointer-events-none absolute -top-px -right-px h-2.5 w-2.5 border-t-2 border-r-2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100" />
            <span class="border-highlight-strongest pointer-events-none absolute -bottom-px -left-px h-2.5 w-2.5 border-b-2 border-l-2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100" />
            <span class="border-highlight-strongest pointer-events-none absolute -bottom-px -right-px h-2.5 w-2.5 border-r-2 border-b-2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100" />
        </div>
    </div>
    )
}
