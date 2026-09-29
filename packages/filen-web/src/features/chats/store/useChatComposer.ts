import { create } from "zustand"
import { NEW_MODE, type ChatComposerMode } from "@/features/chats/lib/composer.logic"

// Cross-component channel between a portaled message menu (which requests reply/edit) and the composer
// (which owns the input). Mobile uses per-uuid secureStore keys (chatInputValue/chatReplyTo/
// chatEditMessage) the menu writes and the input reads; the web equivalent is this per-chat store: the
// menu sets the mode (+ seeds the draft on edit), the composer renders it reactively. The DRAFT lives
// here too (synchronous, survives navigation between chats — the stated minimum) and is mirrored to disk
// separately (lib/drafts.ts) for cross-reload durability, mobile parity.

interface ChatComposerEntry {
	draft: string
	mode: ChatComposerMode
	// Incremented whenever the input should re-focus (reply/edit requested, or after send/cancel).
	// The composer effect focuses when this changes — the web analogue of mobile's "focusChatInput" event.
	focusNonce: number
}

const EMPTY_ENTRY: ChatComposerEntry = {
	draft: "",
	mode: NEW_MODE,
	focusNonce: 0
}

interface ChatComposerStore {
	entries: Record<string, ChatComposerEntry>
	setDraft: (chatUuid: string, draft: string) => void
	setMode: (chatUuid: string, mode: ChatComposerMode) => void
	// Edit: load the target's text into the draft AND pin edit mode in one write (focus nudged).
	beginEdit: (chatUuid: string, mode: ChatComposerMode, draft: string) => void
	// Reply: pin the quoted target, keep the current draft (focus nudged).
	beginReply: (chatUuid: string, mode: ChatComposerMode) => void
	// After a successful send / cancel: clear the draft and return to new-message mode.
	reset: (chatUuid: string) => void
}

function entryOf(entries: Record<string, ChatComposerEntry>, chatUuid: string): ChatComposerEntry {
	return entries[chatUuid] ?? EMPTY_ENTRY
}

export const useChatComposerStore = create<ChatComposerStore>(set => {
	function patchEntry(chatUuid: string, patch: (prev: ChatComposerEntry) => Partial<ChatComposerEntry>): void {
		set(state => {
			const prev = entryOf(state.entries, chatUuid)

			return {
				entries: {
					...state.entries,
					[chatUuid]: {
						...prev,
						...patch(prev)
					}
				}
			}
		})
	}

	return {
		entries: {},
		setDraft(chatUuid, draft) {
			patchEntry(chatUuid, () => ({ draft }))
		},
		setMode(chatUuid, mode) {
			patchEntry(chatUuid, () => ({ mode }))
		},
		beginEdit(chatUuid, mode, draft) {
			patchEntry(chatUuid, prev => ({ draft, mode, focusNonce: prev.focusNonce + 1 }))
		},
		beginReply(chatUuid, mode) {
			patchEntry(chatUuid, prev => ({ mode, focusNonce: prev.focusNonce + 1 }))
		},
		reset(chatUuid) {
			patchEntry(chatUuid, prev => ({ draft: "", mode: NEW_MODE, focusNonce: prev.focusNonce + 1 }))
		}
	}
})

export function useChatComposerEntry(chatUuid: string): ChatComposerEntry {
	return useChatComposerStore(state => state.entries[chatUuid] ?? EMPTY_ENTRY)
}

export default useChatComposerStore
