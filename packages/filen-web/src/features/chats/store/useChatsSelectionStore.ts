import { create } from "zustand"
import type { Chat } from "@filen/sdk-rs"

// Add if absent (by uuid), remove if present — mirrors useNotesSelectionStore's own toggleInArray.
// Returns a new array; the input is never mutated.
function toggleInArray<T>(items: T[], item: T, getId: (item: T) => string): T[] {
	const id = getId(item)
	const index = items.findIndex(existing => getId(existing) === id)

	if (index >= 0) {
		return [...items.slice(0, index), ...items.slice(index + 1)]
	}

	return [...items, item]
}

const chatId = (chat: Chat): string => chat.uuid

interface ChatsSelectionState {
	selectedChats: Chat[]
	setSelectedChats: (next: Chat[] | ((prev: Chat[]) => Chat[])) => void
	toggleSelectedChat: (chat: Chat) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedChats: () => void
}

// The chats-list multi-selection store — a port of useNotesSelectionStore's shape onto Chat. Kept as
// its own small store (not a generic "selection" store parameterized over item type) for the same
// reason useNotesSelectionStore isn't: each surface's selection is read by a different set of
// components with a different re-render footprint, and a shared store would over-notify every
// subscriber on every domain's change. Unlike notes (whose tags view can render the same note twice,
// once per expanded tag group), the chats sidebar is a single flat list with exactly one row per
// conversation — no dedupe pass is needed on write.
export const useChatsSelectionStore = create<ChatsSelectionState>(set => ({
	selectedChats: [],
	setSelectedChats: next => {
		set(state => ({
			selectedChats: typeof next === "function" ? next(state.selectedChats) : next
		}))
	},
	toggleSelectedChat: chat => {
		set(state => ({
			selectedChats: toggleInArray(state.selectedChats, chat, chatId)
		}))
	},
	removeFromSelection: uuids => {
		set(state => {
			const toRemove = new Set(uuids)
			const next = state.selectedChats.filter(chat => !toRemove.has(chatId(chat)))

			// Avoid a needless state update (and re-render) when nothing was actually selected.
			if (next.length === state.selectedChats.length) {
				return state
			}

			return { selectedChats: next }
		})
	},
	clearSelectedChats: () => {
		set({ selectedChats: [] })
	}
}))
