import { create } from "zustand"
import { type ChatTyping, type ChatMessage, type Chat, FilenSdkError } from "@filen/sdk-rs"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type InputViewLayout = {
	width: number
	height: number
	x: number
	y: number
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
	inflightErrors: Record<string, Error | FilenSdkError>
	selectedChats: Chat[]
	setSelectedChats: (fn: Chat[] | ((prev: Chat[]) => Chat[])) => void
	toggleSelectedChat: (chat: Chat) => void
	clearSelectedChats: () => void
	selectAllChats: (chats: Chat[]) => void
	setInflightErrors: (
		fn: Record<string, Error | FilenSdkError> | ((prev: Record<string, Error | FilenSdkError>) => Record<string, Error | FilenSdkError>)
	) => void
	setInflightMessages: (fn: InflightChatMessages | ((prev: InflightChatMessages) => InflightChatMessages)) => void
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
		height: 0,
		x: 0,
		y: 0
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
	selectedChats: [],
	setSelectedChats(selectedChats) {
		set(state => ({
			selectedChats: typeof selectedChats === "function" ? selectedChats(state.selectedChats) : selectedChats
		}))
	},
	toggleSelectedChat(chat) {
		set(state => ({
			selectedChats: toggleInArray(state.selectedChats, chat, c => c.uuid)
		}))
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
