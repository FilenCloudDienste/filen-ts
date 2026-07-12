import type { Chat, ChatMessage, ChatParticipant, MaybeEncrypted, ChatTypingType, UserInfo } from "@filen/sdk-rs"
import { registerSocketHandler, decryptedOrSkip } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { log } from "@/lib/log"
import { CHATS_QUERY_KEY, chatsQueryUpdate, chatsQueryUpsert, chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryUpdate, chatMessagesQueryGet, chatMessagesQueryKey } from "@/features/chats/queries/chatMessages"
import { CHATS_UNREAD_QUERY_KEY } from "@/features/chats/queries/chatsUnread"
import { purgeChatInflightState } from "@/features/chats/lib/inflight"
import { applyTypingSignal, clearTypingForSender } from "@/features/chats/lib/typing"
import { useChatTypingStore, type ChatTypingUser } from "@/features/chats/store/useChatTyping"
import { isChatFocused, getFocusedChat, setFocusedChat } from "@/features/chats/lib/focusedChat"

// The realtime CHAT event handlers — a faithful port of filen-mobile's chats socketHandlers.ts semantics
// onto the flat wasm surface, registered on the generic socket bridge (a pure consumer; the bridge itself
// is untouched). One handler per top-level type: "chat" for the domain events, plus "reconnecting" /
// "authSuccess" for the reconnect full-reconcile (see the section below).

type UuidStr = Chat["uuid"]

// The wasm `ChatEvent` union resolves to `any` for consumers here: sdk-rs.d.ts ships a DUPLICATE
// `ChatTyping` interface declaration whose members conflict (senderId number vs bigint, chat vs
// conversation), which poisons `ChatEvent` (and thus the "chat" arm of SocketEvent) to `any` under this
// build's skipLibCheck. Re-declare the exact variant shapes we consume — verified field-by-field against
// the browser export condition of sdk-rs.d.ts@0.4.34 — so every handler narrows type-safely off a real
// discriminated union instead of reading properties off `any`.
type ChatEventInner =
	| { type: "messageNew"; msg: ChatMessage }
	| { type: "messageEdited"; chat: UuidStr; uuid: UuidStr; newContent: MaybeEncrypted<string>; editedTimestamp: bigint }
	| { type: "messageDelete"; uuid: UuidStr }
	| { type: "messageEmbedDisabled"; uuid: UuidStr }
	| {
			type: "typing"
			chat: UuidStr
			senderId: number
			senderEmail: string
			senderNickName: string
			senderAvatar?: string
			timestamp: bigint
			typingType: ChatTypingType
	  }
	| { type: "conversationsNew"; chat: Chat }
	| { type: "conversationDeleted"; uuid: UuidStr }
	| { type: "conversationNameEdited"; chat: UuidStr; newName: MaybeEncrypted<string> }
	| { type: "conversationParticipantNew"; chat: UuidStr; participant: ChatParticipant }
	| { type: "conversationParticipantLeft"; uuid: UuidStr; userId: bigint }

interface TypedChatSocketEvent {
	inner: ChatEventInner
	chatMessageId: bigint
}

// Own messages: hold the socket-echo cache patch this long so the send outbox's commit reconciles the
// optimistic copy (uuid === inflightId) into its server uuid FIRST — otherwise an echo landing before the
// commit would double-render (optimistic bubble + server bubble) until the commit prunes the optimistic
// one. Mobile's exact value; foreign messages patch effectively immediately.
const OWN_MESSAGE_RECONCILE_DELAY_MS = 3_000
const FOREIGN_MESSAGE_DELAY_MS = 1

function currentUserId(): bigint | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.id
}

function bySentTimestampAsc(a: ChatMessage, b: ChatMessage): number {
	return a.sentTimestamp === b.sentTimestamp ? 0 : a.sentTimestamp < b.sentTimestamp ? -1 : 1
}

// Own-message reconcile patches (see OWN_MESSAGE_RECONCILE_DELAY_MS) sit in a plain setTimeout for up to
// 3s — long enough for a same-chat conversationDeleted to land first. Track the pending timer per chat so
// the deletion handler can cancel it before it fires and recreates the message-cache slice being purged.
const pendingOwnMessageTimeouts = new Map<string, Set<ReturnType<typeof setTimeout>>>()

function trackOwnMessageTimeout(chatUuid: string, id: ReturnType<typeof setTimeout>): void {
	const pending = pendingOwnMessageTimeouts.get(chatUuid) ?? new Set()

	pending.add(id)
	pendingOwnMessageTimeouts.set(chatUuid, pending)
}

function untrackOwnMessageTimeout(chatUuid: string, id: ReturnType<typeof setTimeout>): void {
	const pending = pendingOwnMessageTimeouts.get(chatUuid)

	if (pending === undefined) {
		return
	}

	pending.delete(id)

	if (pending.size === 0) {
		pendingOwnMessageTimeouts.delete(chatUuid)
	}
}

function clearPendingOwnMessageTimeouts(chatUuid: string): void {
	const pending = pendingOwnMessageTimeouts.get(chatUuid)

	if (pending === undefined) {
		return
	}

	for (const id of pending) {
		clearTimeout(id)
	}

	pendingOwnMessageTimeouts.delete(chatUuid)
}

// Resolve the chat that currently holds `messageUuid` in its message cache — MessageDelete /
// MessageEmbedDisabled carry only the message uuid (no chat), so mobile searches every cached thread.
function findChatUuidForMessage(messageUuid: string): string | undefined {
	return chatsQueryGet()?.find(chat => chatMessagesQueryGet(chat.uuid)?.some(m => m.uuid === messageUuid))?.uuid
}

export function handleChatEvent(event: TypedChatSocketEvent): void {
	const inner = event.inner

	switch (inner.type) {
		case "typing": {
			const user: ChatTypingUser = {
				// BigInt-coerced at the seam: senderId is `number` on the wasm surface (a codegen quirk —
				// every other user id is bigint), so it must be coerced before it can match a bigint account id.
				senderId: BigInt(inner.senderId),
				senderEmail: inner.senderEmail,
				senderNickName: inner.senderNickName,
				senderAvatar: inner.senderAvatar,
				timestamp: inner.timestamp
			}

			applyTypingSignal(inner.chat, user, inner.typingType)

			return
		}

		case "messageNew": {
			handleMessageNew(inner.msg)

			return
		}

		case "messageEdited": {
			const newContent = decryptedOrSkip(inner.newContent, "chat messageEdited")

			if (newContent === undefined) {
				return
			}

			chatMessagesQueryUpdate(inner.chat, prev =>
				prev.map(m =>
					m.uuid === inner.uuid ? { ...m, message: newContent, edited: true, editedTimestamp: inner.editedTimestamp } : m
				)
			)

			return
		}

		case "messageDelete": {
			const chatUuid = findChatUuidForMessage(inner.uuid)

			if (chatUuid === undefined) {
				log.warn("socket", "chat messageDelete: message not in any cached thread", inner.uuid)

				return
			}

			chatMessagesQueryUpdate(chatUuid, prev => prev.filter(m => m.uuid !== inner.uuid))

			return
		}

		case "messageEmbedDisabled": {
			const chatUuid = findChatUuidForMessage(inner.uuid)

			if (chatUuid === undefined) {
				return
			}

			chatMessagesQueryUpdate(chatUuid, prev => prev.map(m => (m.uuid === inner.uuid ? { ...m, embedDisabled: true } : m)))

			return
		}

		case "conversationsNew": {
			// A chat introduced without a listChats — upsert it so opening it before the list refetches
			// resolves (the route + message query both read the list cache).
			chatsQueryUpsert(inner.chat)

			return
		}

		case "conversationNameEdited": {
			const name = decryptedOrSkip(inner.newName, "chat conversationNameEdited")

			if (name === undefined) {
				return
			}

			chatsQueryUpdate(prev => prev.map(c => (c.uuid === inner.chat ? { ...c, name } : c)))

			return
		}

		case "conversationParticipantNew": {
			chatsQueryUpdate(prev =>
				prev.map(c =>
					c.uuid === inner.chat
						? { ...c, participants: [...c.participants.filter(p => p.userId !== inner.participant.userId), inner.participant] }
						: c
				)
			)

			return
		}

		case "conversationParticipantLeft": {
			chatsQueryUpdate(prev =>
				prev.map(c => (c.uuid === inner.uuid ? { ...c, participants: c.participants.filter(p => p.userId !== inner.userId) } : c))
			)

			return
		}

		case "conversationDeleted": {
			// Fire-and-forget: the purge is async (best-effort, never throws), and dispatch runs handlers
			// synchronously — the promise is owned here with its own catch, never surfaced up the sync seam.
			void handleConversationDeleted(inner.uuid).catch((e: unknown) => {
				log.error("socket", "conversationDeleted handler threw", e)
			})

			return
		}

		default: {
			// Exhaustive over the wasm ChatEvent union — a new variant fails to compile here until mapped.
			log.error("socket", "unhandled chat event", (inner as { type: string }).type)

			return
		}
	}
}

function handleMessageNew(msg: ChatMessage): void {
	const senderId = BigInt(msg.senderId)
	const userId = currentUserId()
	const isOwn = userId !== undefined && senderId === userId
	// Snapshot focus NOW (at event time) — the delayed patch below runs later, by when the user may have
	// navigated away; the unread decision must reflect where they were when the message arrived.
	const focused = isChatFocused(msg.chat)

	// A new message from this sender supersedes their typing indicator.
	clearTypingForSender(msg.chat, senderId)

	const timeoutId = setTimeout(
		() => {
			if (isOwn) {
				untrackOwnMessageTimeout(msg.chat, timeoutId)
			}

			// Dedup by SERVER uuid against the thread cache AND the reconciled outbox: if the message is
			// already present (our own send's commit reconciled the optimistic copy, or a prior echo landed),
			// leave it untouched instead of re-appending a duplicate.
			chatMessagesQueryUpdate(msg.chat, prev =>
				prev.some(m => m.uuid === msg.uuid) ? prev : [...prev, msg].sort(bySentTimestampAsc)
			)

			// Patch the conversation row AFTER the message cache (mobile's ordering). Always refresh
			// lastMessage/timestamp; for a FOREIGN message in the FOCUSED chat, advance lastFocus so the
			// derived per-row unread stays false — unread accrues ONLY when the chat is not the open one.
			setTimeout(() => {
				chatsQueryUpdate(prev =>
					prev.map(c => {
						if (c.uuid !== msg.chat) {
							return c
						}

						const advanceFocus = !isOwn && focused && msg.sentTimestamp > c.lastFocus

						return { ...c, lastMessage: msg, ...(advanceFocus ? { lastFocus: msg.sentTimestamp } : {}) }
					})
				)

				// A foreign message landing in a chat the user is NOT currently looking at is a genuine
				// unread arrival — invalidate the rail badge's scalar so it refetches instead of staying dark
				// until the next blur/reconnect (that scalar has no per-event patch path of its own).
				if (!isOwn && !focused) {
					void queryClient.invalidateQueries({ queryKey: CHATS_UNREAD_QUERY_KEY })
				}
			}, 1)
		},
		isOwn ? OWN_MESSAGE_RECONCILE_DELAY_MS : FOREIGN_MESSAGE_DELAY_MS
	)

	if (isOwn) {
		trackOwnMessageTimeout(msg.chat, timeoutId)
	}
}

// Exported for the unit tests' purge-order assertion — awaited directly there since handleChatEvent fires
// it and returns synchronously.
export async function handleConversationDeleted(uuid: string): Promise<void> {
	// Cancel first: an own-message reconcile patch still pending for this chat would otherwise fire after
	// the purge below and recreate the message-cache slice it just emptied.
	clearPendingOwnMessageTimeouts(uuid)

	// Purge-first: drop the deleted chat's queued unsent messages, send errors and input draft
	// BEFORE the cache removal so a concurrent send loop never resolves + retries into a gone chat. Best-
	// effort (never throws).
	await purgeChatInflightState(uuid)

	// Drop any typing state for the gone chat.
	useChatTypingStore.getState().setTyping(prev => {
		if (prev[uuid] === undefined) {
			return prev
		}

		const updated = { ...prev }

		Reflect.deleteProperty(updated, uuid)

		return updated
	})

	// Cache removal — the open thread route resolves the chat from the list cache, so removing it here
	// re-renders that route to the select-a-conversation placeholder (the web nav-away: no imperative
	// navigation needed, unlike mobile's stack redirect).
	chatMessagesQueryUpdate(uuid, () => [])
	chatsQueryUpdate(prev => prev.filter(c => c.uuid !== uuid))

	if (getFocusedChat() === uuid) {
		setFocusedChat(null)
	}
}

// ── Reconnect full-reconcile ──────────────────────────────────────────────
// The SDK owns the socket's own reconnect and surfaces it through this same event stream as a
// "reconnecting" then (on success) an "authSuccess". We reconcile ONLY on the authSuccess that FOLLOWS a
// reconnecting — never the initial post-login authSuccess (the list/thread are already fetching then) — by
// invalidating the open thread + the conversation list + the unread count so missed events can't leave
// stale state. Exported for the unit tests' reconnect assertions.
let sawReconnecting = false

export function handleReconnecting(): void {
	sawReconnecting = true
}

export function handleAuthSuccess(): void {
	if (!sawReconnecting) {
		return
	}

	sawReconnecting = false

	void queryClient.invalidateQueries({ queryKey: CHATS_QUERY_KEY })
	void queryClient.invalidateQueries({ queryKey: CHATS_UNREAD_QUERY_KEY })

	const focused = getFocusedChat()

	if (focused !== null) {
		void queryClient.invalidateQueries({ queryKey: chatMessagesQueryKey(focused) })
	}
}

// Registers the chat handlers on the generic bridge; returns the combined unregister fn. Called once by
// the authed shell's socket host, alongside the note handlers. The wasm "chat" arm carries `inner: any`
// (the duplicate ChatTyping declaration poisons ChatEvent — see ChatEventInner above), so the event is
// structurally assignable to our re-declared TypedChatSocketEvent with no cast, and handleChatEvent narrows
// off the real union from there. A throwing handler is already isolated by the bridge's own dispatch.
export function registerChatSocketHandlers(): () => void {
	const unregisterChat = registerSocketHandler("chat", handleChatEvent)

	const unregisterReconnecting = registerSocketHandler("reconnecting", handleReconnecting)
	const unregisterAuthSuccess = registerSocketHandler("authSuccess", handleAuthSuccess)

	return () => {
		unregisterChat()
		unregisterReconnecting()
		unregisterAuthSuccess()
	}
}
