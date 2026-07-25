import { For, Show, type Component } from 'solid-js'
import type { Tag } from '../api'
import { contrastingTextColor } from '../tagColors'
import { visibleTags } from '../tagFacets'

interface TagBarProps {
    tags: Tag[]
    selectedTagIds: string[]
    onToggleTag: (id: string) => void
    onClear: () => void
    onDeleteTag: (tag: Tag) => void
    // Whether the current user may delete tags. When false, the per-tag delete
    // affordance is hidden (view/filter only).
    canManage: boolean
    // Tags that still match at least one moment under the current filter, from
    // the server's facet endpoint. null means the answer has not arrived yet.
    availableTagIds?: Set<string> | null
}

// The filter bar for tags. Filtering and deleting only: tags are created in the
// moment composer, attached to the moment being written.
//
// Creating them here made tags that belonged to nothing. That was already a
// vocabulary nobody had asked for, and it got worse once the bar started hiding
// tags with no moments (see tagFacets.ts): a tag created here vanished the
// instant it was made, which reads as the button being broken. Creating a tag
// where it is immediately used means it always has somewhere to appear.
export const TagBar: Component<TagBarProps> = (props) => {
    const shown = () => visibleTags(props.tags, props.availableTagIds, props.selectedTagIds)

    return (
        <div data-testid="tag-bar" class="bg-element z-10 flex w-full flex-wrap items-center justify-center gap-2 p-2 backdrop-blur-md transition-all lg:max-h-[20vh] lg:overflow-y-auto lg:p-6">
            <span class="text-sub text-xs font-black tracking-widest uppercase">
                Tags:
            </span>
            <For each={shown()}>
                {(tag) => (
                    <div class="group relative">
                        <button
                            onClick={() => props.onToggleTag(tag.id)}
                            class={`rounded-lg p-2 text-xs font-black tracking-wide uppercase transition-[filter,box-shadow] duration-100 hover:cursor-pointer ${
                                props.selectedTagIds.includes(tag.id)
                                    ? 'shadow-highlight-strongest border-plain border-2 shadow-sm'
                                    : 'hover:brightness-110'
                            }`}
                            style={{
                                'background-color': tag.color,
                                color: contrastingTextColor(tag.color),
                            }}
                        >
                            #{tag.name}
                        </button>
                        <Show when={props.canManage}>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    props.onDeleteTag(tag)
                                }}
                                title={`Delete tag ${tag.name}`}
                                class="bg-element-matte border-element-accent text-sub hover:text-danger hover:border-danger absolute -top-2 -right-2 flex h-4 w-4 items-center justify-center rounded-full border opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:cursor-pointer"
                            >
                                <span class="material-symbols-outlined text-[10px] leading-none">close</span>
                            </button>
                        </Show>
                    </div>
                )}
            </For>

            <Show when={props.selectedTagIds.length > 0}>
                <button
                    onClick={props.onClear}
                    class="text-sub text-xs font-bold tracking-widest uppercase hover:text-highlight-strongest transition-colors"
                >
                    Clear
                </button>
            </Show>
        </div>
    )
}
