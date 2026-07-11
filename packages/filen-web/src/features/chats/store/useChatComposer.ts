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
	// Incremented whenever the input should re-focus (reply/edit requested, or a focus nudge on open).
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
	// Request the composer to focus without otherwise changing state (chat open).
	requestFocus: (chatUuid: string) => void
}

function entryOf(entries: Record<string, ChatComposerEntry>, chatUuid: string): ChatComposerEntry {
	return entries[chatUuid] ?? EMPTY_ENTRY
}

export const useChatComposerStore = create<ChatComposerStore>(set => ({
	entries: {},
	setDraft(chatUuid, draft) {
		set(state => ({
			entries: {
				...state.entries,
				[chatUuid]: {
					...entryOf(state.entries, chatUuid),
					draft
				}
			}
		}))
	},
	setMode(chatUuid, mode) {
		set(state => ({
			entries: {
				...state.entries,
				[chatUuid]: {
					...entryOf(state.entries, chatUuid),
					mode
				}
			}
		}))
	},
	beginEdit(chatUuid, mode, draft) {
		set(state => {
			const prev = entryOf(state.entries, chatUuid)

			return {
				entries: {
					...state.entries,
					[chatUuid]: {
						draft,
						mode,
						focusNonce: prev.focusNonce + 1
					}
				}
			}
		})
	},
	beginReply(chatUuid, mode) {
		set(state => {
			const prev = entryOf(state.entries, chatUuid)

			return {
				entries: {
					...state.entries,
					[chatUuid]: {
						...prev,
						mode,
						focusNonce: prev.focusNonce + 1
					}
				}
			}
		})
	},
	reset(chatUuid) {
		set(state => {
			const prev = entryOf(state.entries, chatUuid)

			return {
				entries: {
					...state.entries,
					[chatUuid]: {
						draft: "",
						mode: NEW_MODE,
						focusNonce: prev.focusNonce + 1
					}
				}
			}
		})
	},
	requestFocus(chatUuid) {
		set(state => {
			const prev = entryOf(state.entries, chatUuid)

			return {
				entries: {
					...state.entries,
					[chatUuid]: {
						...prev,
						focusNonce: prev.focusNonce + 1
					}
				}
			}
		})
	}
}))

export function useChatComposerEntry(chatUuid: string): ChatComposerEntry {
	return useChatComposerStore(state => state.entries[chatUuid] ?? EMPTY_ENTRY)
}

export default useChatComposerStore
