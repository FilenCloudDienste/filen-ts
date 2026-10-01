import type { Chat } from "@filen/sdk-rs"
import { useListPointerSelection, type ListPointerSelection, type ListPointerSelectionActions } from "@/lib/useListPointerSelection"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"

export interface UseChatsListSelectionParams {
	// chatsSidebar.tsx's own search-filtered `rows`, in render order.
	chats: readonly Chat[]
	// The live (ghost-purged) selection's size, which puts a touch tap into selection mode.
	selectionCount: number
}

const CHATS_SELECTION_ACTIONS: ListPointerSelectionActions<Chat> = {
	set: chats => {
		useChatsSelectionStore.getState().setSelectedChats(chats)
	},
	toggle: chat => {
		useChatsSelectionStore.getState().toggleSelectedChat(chat)
	},
	clear: () => {
		useChatsSelectionStore.getState().clearSelectedChats()
	}
}

// Plain click on a row still lets its Link navigate (see chatRow.tsx). Clears on BOTH mount and
// unmount: ChatsSidebar only mounts while routed under /chats* (appShell.tsx swaps the contextual
// sidebar out off that route), the web equivalent of mobile's List-screen useFocusEffect clearing
// `selectedChats` on focus and blur, so leaving the module never strands a selection in the store.
export function useChatsListSelection({ chats, selectionCount }: UseChatsListSelectionParams): ListPointerSelection {
	return useListPointerSelection({ items: chats, actions: CHATS_SELECTION_ACTIONS, clearOnUnmount: true, selectionCount })
}
