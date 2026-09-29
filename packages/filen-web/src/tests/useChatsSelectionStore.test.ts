import { beforeEach } from "vitest"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import { describeSelectionStoreContract } from "@/tests/contracts/selection"
import { mockChat } from "@/tests/fixtures/sdk"

beforeEach(() => {
	useChatsSelectionStore.setState({ selectedChats: [] })
})

describeSelectionStoreContract({
	makeItem: uuid => mockChat({ uuid }),
	selected: () => useChatsSelectionStore.getState().selectedChats,
	seed: selectedChats => {
		useChatsSelectionStore.setState({ selectedChats })
	},
	toggle: chat => {
		useChatsSelectionStore.getState().toggleSelectedChat(chat)
	},
	set: next => {
		useChatsSelectionStore.getState().setSelectedChats(next)
	},
	remove: uuids => {
		useChatsSelectionStore.getState().removeFromSelection(uuids)
	},
	clear: () => {
		useChatsSelectionStore.getState().clearSelectedChats()
	}
})
