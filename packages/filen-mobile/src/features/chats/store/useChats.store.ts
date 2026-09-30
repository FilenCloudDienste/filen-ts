import { create } from "zustand"
import { type ChatTyping, FilenSdkError } from "@filen/sdk-rs"
import { removeSelectedIds, toggleInArray } from "@filen/shared"
import { type Chat, type ChatMessage } from "@/types"

const chatId = (chat: Chat): string => chat.uuid

export type InputViewLayout = {
	width: number
	height: number
}

export type Suggestions = "mentions" | "reply" | "emojis"
export type Typing = Omit<ChatTyping, "typingType">[]

export type ChatMessageWithInflightId = ChatMessage & {
	inflightId: string
}

export type InflightChatMessages = Record<
	string,
	{
		chat: Chat
		messages: ChatMessageWithInflightId[]
	}
>

// Per-inflightId send-failure record. `permanentRejections` counts CONSECUTIVE non-network,
// non-auth SDK rejections (the chats sync drops the message from the queue once it reaches its
// bound — see MAX_NON_RETRYABLE_REJECTIONS in features/chats/components/sync). `message` is the
// snapshot kept so a dropped (no longer queued) failed send stays renderable in the message list
// until the user retries/removes it, and so purges can match errors to their chat.
export type InflightChatMessageError = {
	error: Error | FilenSdkError
	permanentRejections: number
	message: ChatMessageWithInflightId
}

export type InflightChatMessageErrors = Record<string, InflightChatMessageError>

// Both return `prev` unchanged when there is nothing to remove, so no-op updates don't notify.
export function withoutInflightMessage(prev: InflightChatMessages, chatUuid: string, inflightId: string): InflightChatMessages {
	const existing = prev[chatUuid]

	if (!existing) {
		return prev
	}

	const remaining = existing.messages.filter(m => m.inflightId !== inflightId)

	if (remaining.length === existing.messages.length) {
		return prev
	}

	const updated = {
		...prev
	}

	if (remaining.length === 0) {
		delete updated[chatUuid]
	} else {
		updated[chatUuid] = {
			...existing,
			messages: remaining
		}
	}

	return updated
}

export function withoutInflightError(prev: InflightChatMessageErrors, inflightId: string): InflightChatMessageErrors {
	if (!prev[inflightId]) {
		return prev
	}

	const updated = {
		...prev
	}

	delete updated[inflightId]

	return updated
}

// Older paginated pages, keyed per mounted message list (not per chat) so two screens on one chat
// keep independent pages. Lives here only so message patches can reach it.
export type OlderChatMessages = Record<
	string,
	{
		chatUuid: string
		messages: ChatMessageWithInflightId[]
	}
>

export type ChatMessagePatch = ((message: ChatMessageWithInflightId) => ChatMessageWithInflightId) | "delete"

export function applyChatMessagePatch(
	messages: ChatMessageWithInflightId[],
	messageUuid: string,
	patch: ChatMessagePatch
): ChatMessageWithInflightId[] {
	return patch === "delete" ? messages.filter(m => m.inner.uuid !== messageUuid) : messages.map(m => (m.inner.uuid === messageUuid ? patch(m) : m))
}

export function olderMessagesChatUuid(prev: OlderChatMessages, messageUuid: string): string | undefined {
	for (const entry of Object.values(prev)) {
		if (entry.messages.some(m => m.inner.uuid === messageUuid)) {
			return entry.chatUuid
		}
	}

	return undefined
}

// Returns `prev` when no page holds the message, and keeps untouched entries by reference.
export function withPatchedOlderMessage(prev: OlderChatMessages, messageUuid: string, patch: ChatMessagePatch): OlderChatMessages {
	let next: OlderChatMessages | null = null

	for (const [instanceId, entry] of Object.entries(prev)) {
		if (!entry.messages.some(m => m.inner.uuid === messageUuid)) {
			continue
		}

		next ??= {
			...prev
		}

		next[instanceId] = {
			...entry,
			messages: applyChatMessagePatch(entry.messages, messageUuid, patch)
		}
	}

	return next ?? prev
}

export type ChatsStore = {
	inputViewLayout: InputViewLayout
	inputSelection: {
		start: number
		end: number
	}
	suggestionsVisible: Suggestions[]
	inputFocused: boolean
	typing: Record<string, Typing>
	inflightMessages: InflightChatMessages
	inflightErrors: InflightChatMessageErrors
	olderMessages: OlderChatMessages
	appendOlderMessages: (instanceId: string, chatUuid: string, messages: ChatMessageWithInflightId[]) => void
	clearOlderMessages: (instanceId: string) => void
	patchOlderMessage: (messageUuid: string, patch: ChatMessagePatch) => void
	selectedChats: Chat[]
	setSelectedChats: (chats: Chat[]) => void
	toggleSelectedChat: (chat: Chat) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedChats: () => void
	selectAllChats: (chats: Chat[]) => void
	setInflightErrors: (fn: InflightChatMessageErrors | ((prev: InflightChatMessageErrors) => InflightChatMessageErrors)) => void
	setInflightMessages: (fn: InflightChatMessages | ((prev: InflightChatMessages) => InflightChatMessages)) => void
	dequeueInflightMessage: (chatUuid: string, inflightId: string) => void
	clearInflightError: (inflightId: string) => void
	setTyping: (fn: Record<string, Typing> | ((prev: Record<string, Typing>) => Record<string, Typing>)) => void
	setInputFocused: (fn: boolean | ((prev: boolean) => boolean)) => void
	setSuggestionsVisible: (fn: Suggestions[] | ((prev: Suggestions[]) => Suggestions[])) => void
	setInputSelection: (
		selection:
			| {
					start: number
					end: number
			  }
			| ((prev: { start: number; end: number }) => {
					start: number
					end: number
			  })
	) => void
	setInputViewLayout: (fn: InputViewLayout | ((prev: InputViewLayout) => InputViewLayout)) => void
}

export const useChatsStore = create<ChatsStore>(set => ({
	inputViewLayout: {
		width: 0,
		height: 0
	},
	inputSelection: {
		start: 0,
		end: 0
	},
	suggestionsVisible: [],
	inputFocused: false,
	typing: {},
	inflightMessages: {},
	inflightErrors: {},
	olderMessages: {},
	appendOlderMessages(instanceId, chatUuid, messages) {
		set(state => ({
			olderMessages: {
				...state.olderMessages,
				[instanceId]: {
					chatUuid,
					messages: [...(state.olderMessages[instanceId]?.messages ?? []), ...messages]
				}
			}
		}))
	},
	clearOlderMessages(instanceId) {
		set(state => {
			if (!state.olderMessages[instanceId]) {
				return state
			}

			const olderMessages = {
				...state.olderMessages
			}

			delete olderMessages[instanceId]

			return { olderMessages }
		})
	},
	patchOlderMessage(messageUuid, patch) {
		set(state => {
			const next = withPatchedOlderMessage(state.olderMessages, messageUuid, patch)

			return next === state.olderMessages ? state : { olderMessages: next }
		})
	},
	selectedChats: [],
	setSelectedChats(selectedChats) {
		set({ selectedChats })
	},
	toggleSelectedChat(chat) {
		set(state => ({
			selectedChats: toggleInArray(state.selectedChats, chat, chatId)
		}))
	},
	removeFromSelection(uuids) {
		set(state => {
			const next = removeSelectedIds(state.selectedChats, uuids, chatId)

			// Avoid a needless state update (and re-render) when nothing was selected.
			if (next === state.selectedChats) {
				return state
			}

			return { selectedChats: next }
		})
	},
	clearSelectedChats() {
		set({ selectedChats: [] })
	},
	selectAllChats(chats) {
		set({ selectedChats: chats })
	},
	setInflightErrors(inflightErrors) {
		set(state => ({
			inflightErrors: typeof inflightErrors === "function" ? inflightErrors(state.inflightErrors) : inflightErrors
		}))
	},
	setInflightMessages(inflightMessages) {
		set(state => ({
			inflightMessages: typeof inflightMessages === "function" ? inflightMessages(state.inflightMessages) : inflightMessages
		}))
	},
	dequeueInflightMessage(chatUuid, inflightId) {
		set(state => {
			const next = withoutInflightMessage(state.inflightMessages, chatUuid, inflightId)

			return next === state.inflightMessages ? state : { inflightMessages: next }
		})
	},
	clearInflightError(inflightId) {
		set(state => {
			const next = withoutInflightError(state.inflightErrors, inflightId)

			return next === state.inflightErrors ? state : { inflightErrors: next }
		})
	},
	setTyping(typing) {
		set(state => ({
			typing: typeof typing === "function" ? typing(state.typing) : typing
		}))
	},
	setInputFocused(focused) {
		set(state => ({
			inputFocused: typeof focused === "function" ? focused(state.inputFocused) : focused
		}))
	},
	setSuggestionsVisible(visible) {
		set(state => ({
			suggestionsVisible: typeof visible === "function" ? visible(state.suggestionsVisible) : visible
		}))
	},
	setInputSelection(selection) {
		set(state => ({
			inputSelection: typeof selection === "function" ? selection(state.inputSelection) : selection
		}))
	},
	setInputViewLayout(fn) {
		set(state => ({
			inputViewLayout: typeof fn === "function" ? fn(state.inputViewLayout) : fn
		}))
	}
}))

export default useChatsStore
