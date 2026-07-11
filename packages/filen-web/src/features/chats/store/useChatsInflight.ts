import { create } from "zustand"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"

// The send outbox's in-memory shape, a faithful port of filen-mobile's InflightChatMessages
// (features/chats/store/useChats.store.ts). Chat sends are APPEND-only and NOT naturally idempotent
// (sendChatMessage takes no client id — each call mints a brand-new server message), so — unlike the
// notes outbox which collapses to ONE overwrite entry per uuid — this is a per-chat QUEUE of DISTINCT
// messages sent sequentially oldest-first, each keyed by a CLIENT-SIDE inflightId that is a local
// reconciliation handle ONLY and is NEVER sent to the server.

// A queued optimistic message carries the flat wasm ChatMessage plus its inflightId. The optimistic
// copy's own `uuid` is SET to the inflightId at enqueue time (mobile does the same: inner.uuid =
// inflightId) so the same id doubles as the message-cache dedup handle before the server assigns a
// real uuid on commit.
export type ChatMessageWithInflightId = ChatMessage & {
	inflightId: string
}

// Per chat: the live Chat snapshot (the push loop needs it to call sendChatMessage) + the ordered
// queue of unsent messages. A chat key is dropped entirely once its queue drains.
export type InflightChatMessages = Record<
	string,
	{
		chat: Chat
		messages: ChatMessageWithInflightId[]
	}
>

// Per-inflightId send-failure record. `permanentRejections` counts CONSECUTIVE non-network, non-auth
// SDK rejections; the push loop drops the message from the queue once it reaches
// MAX_NON_RETRYABLE_REJECTIONS (lib/sync.ts) but KEEPS this error entry so the failed bubble stays
// renderable + actionable (retry/remove). `message` is the snapshot kept so a dropped (no-longer-
// queued) failed send still renders, and so a purge can match errors to their chat.
export interface InflightChatMessageError {
	error: ErrorDTO
	permanentRejections: number
	message: ChatMessageWithInflightId
}

export type InflightChatMessageErrors = Record<string, InflightChatMessageError>

export interface ChatsInflightStore {
	inflightMessages: InflightChatMessages
	inflightErrors: InflightChatMessageErrors
	setInflightMessages: (fn: InflightChatMessages | ((prev: InflightChatMessages) => InflightChatMessages)) => void
	setInflightErrors: (fn: InflightChatMessageErrors | ((prev: InflightChatMessageErrors) => InflightChatMessageErrors)) => void
}

export const useChatsInflightStore = create<ChatsInflightStore>(set => ({
	inflightMessages: {},
	inflightErrors: {},
	setInflightMessages(fn) {
		set(state => ({
			inflightMessages: typeof fn === "function" ? fn(state.inflightMessages) : fn
		}))
	},
	setInflightErrors(fn) {
		set(state => ({
			inflightErrors: typeof fn === "function" ? fn(state.inflightErrors) : fn
		}))
	}
}))

// Reactive per-message send-state for the thread: "failed" (an error record exists — a red bubble with
// retry/remove) wins over "pending" (queued, no error yet — a muted clock bubble); everything else is
// "confirmed". Keyed by the message's own `uuid`, which for an optimistic entry IS its inflightId.
export type ChatSendState = "confirmed" | "pending" | "failed"

export function useChatSendState(messageUuid: string): ChatSendState {
	return useChatsInflightStore(state => {
		if (state.inflightErrors[messageUuid] !== undefined) {
			return "failed"
		}

		for (const group of Object.values(state.inflightMessages)) {
			if (group.messages.some(m => m.inflightId === messageUuid)) {
				return "pending"
			}
		}

		return "confirmed"
	})
}

export default useChatsInflightStore
