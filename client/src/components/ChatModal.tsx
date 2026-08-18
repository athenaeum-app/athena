import { type Component } from 'solid-js'
import { Modal } from './Modal'
import { ChatPanel } from './ChatPanel'

interface ChatModalProps {
    onClose: () => void
    // Embed click-through (ADR-0015).
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
}

// On-demand chat, used on mobile and wherever chat isn't docked in the Menu
// column. A thin modal frame around the shared ChatPanel (which owns all chat
// behaviour); the docked rich-menu widget renders the same ChatPanel inline.
export const ChatModal: Component<ChatModalProps> = (props) => {
    return (
        <Modal onClose={props.onClose} class="animate-fade-in p-4">
            <div class="h-[80vh] w-full max-w-2xl">
                <ChatPanel
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodo}
                    onOpenCanvas={props.onOpenCanvas}
                    onOpenProject={props.onOpenProject}
                    onClose={props.onClose}
                    class="bg-element-matte border-element-accent h-full overflow-hidden rounded-xl border shadow-2xl"
                />
            </div>
        </Modal>
    )
}
