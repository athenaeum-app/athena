import { type Component } from 'solid-js'
import { backdropDismiss } from '../dismiss'
import { ChatPanel } from './ChatPanel'

interface ChatModalProps {
    onClose: () => void
    // Embed click-through (ADR-0015).
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
}

// On-demand chat, used on mobile and wherever chat isn't docked in the Menu
// column. A thin modal frame around the shared ChatPanel (which owns all chat
// behaviour); the docked rich-menu widget renders the same ChatPanel inline.
export const ChatModal: Component<ChatModalProps> = (props) => {
    return (
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in p-4" {...backdropDismiss(props.onClose)}>
            <div class="h-[80vh] w-full max-w-2xl">
                <ChatPanel
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodo}
                    onOpenCanvas={props.onOpenCanvas}
                    onClose={props.onClose}
                    class="bg-element-matte border-element-accent h-full overflow-hidden rounded-xl border shadow-2xl"
                />
            </div>
        </div>
    )
}
