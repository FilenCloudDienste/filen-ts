import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, ChatParticipant, ChatTypingType, UuidStr } from "@filen/sdk-rs"

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short label (chatsQueries.test's
// own testUuid convention).
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// sdkApi is mocked to the one op the send-typing path calls; the query modules import sdkApi but never
// invoke it here (only their cache patchers run).
const { sendTypingSignal } = vi.hoisted(() => ({ sendTypingSignal: vi.fn<() => Promise<void>>(() => Promise.resolve()) }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendTypingSignal } }))

// Purge is mocked so conversationDeleted's ordering is observable and the outbox's heavy deps stay out of
// node.
const { purgeChatInflightState } = vi.hoisted(() => ({ purgeChatInflightState: vi.fn<() => Promise<void>>(() => Promise.resolve()) }))

vi.mock("@/features/chats/lib/inflight", () => ({ purgeChatInflightState }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

// The reconnect handler fires the bulk chat+messages refetch; mock it so the reconnect assertions observe
// the trigger without pulling the real fetch fan-out (and its sdkApi round trips) into node.
const { refetchChatsAndMessages } = vi.hoisted(() => ({ refetchChatsAndMessages: vi.fn<() => Promise<void>>(() => Promise.resolve()) }))

vi.mock("@/features/chats/lib/refetchChatsAndMessages", () => ({ refetchChatsAndMessages }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { CHATS_QUERY_KEY, chatsQueryGet } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey, chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { useChatTypingStore } from "@/features/chats/store/useChatTyping"
import { useSocketStatusStore } from "@/features/chats/store/useSocketStatus"
import { setFocusedChat, getFocusedChat } from "@/features/chats/lib/focusedChat"
import { signalTyping, signalStopped, TYPING_EXPIRY_MS, clearAllTyping } from "@/features/chats/lib/typing"
import { handleChatEvent, handleConversationDeleted, handleReconnecting, handleAuthSuccess } from "@/features/chats/lib/socketHandlers"

function makeChat(uuid: string, overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid(uuid),
		ownerId: 1n,
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

function makeMessage(uuid: string, chatUuid: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid(uuid),
		chat: testUuid(chatUuid),
		senderId: 2,
		senderEmail: "peer@x.io",
		senderNickName: "Peer",
		message: `msg-${uuid}`,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 100n,
		...overrides
	}
}

function participant(userId: bigint): ChatParticipant {
	return {
		userId,
		email: `u${userId.toString()}@x.io`,
		nickName: `u${userId.toString()}`,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n
	}
}

function seedChats(chats: Chat[]): void {
	testQueryClient.setQueryData(CHATS_QUERY_KEY, chats)
}

function seedMessages(chatUuid: string, messages: ChatMessage[]): void {
	testQueryClient.setQueryData(chatMessagesQueryKey(testUuid(chatUuid)), messages)
}

function getChats(): Chat[] {
	return chatsQueryGet() ?? []
}

function getMessages(chatUuid: string): ChatMessage[] {
	return chatMessagesQueryGet(testUuid(chatUuid)) ?? []
}

function typingEvent(chatUuid: string, senderId: number, typingType: ChatTypingType, overrides: Record<string, unknown> = {}) {
	return {
		inner: {
			type: "typing" as const,
			chat: testUuid(chatUuid),
			senderId,
			senderEmail: "peer@x.io",
			senderNickName: "Peer",
			timestamp: 1n,
			typingType,
			...overrides
		},
		chatMessageId: 0n
	}
}

beforeEach(() => {
	testQueryClient.clear()
	useChatTypingStore.setState({ typing: {} })
	setFocusedChat(null)
	vi.clearAllMocks()
})

afterEach(() => {
	vi.useRealTimers()
	clearAllTyping()
})

describe("chat socket handlers — messages", () => {
	it("messageNew appends a foreign message and refreshes the conversation row's lastMessage", () => {
		vi.useFakeTimers()
		seedChats([makeChat("c1")])
		seedMessages("c1", [])

		handleChatEvent({ inner: { type: "messageNew", msg: makeMessage("m1", "c1", { sentTimestamp: 200n }) }, chatMessageId: 0n })
		vi.runAllTimers()

		expect(getMessages("c1").map(m => m.uuid)).toEqual([testUuid("m1")])
		expect(getChats()[0]?.lastMessage?.uuid).toBe(testUuid("m1"))
	})

	it("messageNew de-dups by server uuid (event AFTER commit — already in cache — never doubles)", () => {
		vi.useFakeTimers()
		seedChats([makeChat("c1")])
		seedMessages("c1", [makeMessage("m1", "c1")])

		handleChatEvent({ inner: { type: "messageNew", msg: makeMessage("m1", "c1") }, chatMessageId: 0n })
		vi.runAllTimers()

		expect(getMessages("c1")).toHaveLength(1)
	})

	it("messageNew for an OWN message defers the cache patch by the reconcile delay", () => {
		vi.useFakeTimers()
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 2n })
		seedChats([makeChat("c1")])
		seedMessages("c1", [])

		handleChatEvent({ inner: { type: "messageNew", msg: makeMessage("m1", "c1", { senderId: 2 }) }, chatMessageId: 0n })

		// Not applied before the own-message reconcile window elapses.
		vi.advanceTimersByTime(100)
		expect(getMessages("c1")).toHaveLength(0)

		// Past the reconcile delay (3s) + the nested row-patch tick.
		vi.advanceTimersByTime(3_100)
		expect(getMessages("c1")).toHaveLength(1)
	})

	it("unread gating: a FOREIGN message advances lastFocus for the FOCUSED chat (stays read)", () => {
		vi.useFakeTimers()
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 1n })
		seedChats([makeChat("c1", { lastFocus: 50n })])
		seedMessages("c1", [])
		setFocusedChat(testUuid("c1"))

		handleChatEvent({
			inner: { type: "messageNew", msg: makeMessage("m1", "c1", { senderId: 2, sentTimestamp: 200n }) },
			chatMessageId: 0n
		})
		vi.runAllTimers()

		const chat = getChats()[0]
		expect(chat?.lastFocus).toBe(200n)
		expect(chat !== undefined ? chatHasUnread(chat, 1n) : true).toBe(false)
	})

	it("unread gating: a FOREIGN message in a NON-focused chat leaves lastFocus (derives unread)", () => {
		vi.useFakeTimers()
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 1n })
		seedChats([makeChat("c1", { lastFocus: 50n })])
		seedMessages("c1", [])
		setFocusedChat(testUuid("other"))

		handleChatEvent({
			inner: { type: "messageNew", msg: makeMessage("m1", "c1", { senderId: 2, sentTimestamp: 200n }) },
			chatMessageId: 0n
		})
		vi.runAllTimers()

		const chat = getChats()[0]
		expect(chat?.lastFocus).toBe(50n)
		expect(chat !== undefined ? chatHasUnread(chat, 1n) : false).toBe(true)
	})

	it("a FOREIGN message in a NON-focused chat writes NO badge invalidation — the message landing in cache re-derives the count", () => {
		vi.useFakeTimers()
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 1n })
		seedChats([makeChat("c1", { lastFocus: 50n })])
		seedMessages("c1", [])
		setFocusedChat(testUuid("other"))
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleChatEvent({
			inner: { type: "messageNew", msg: makeMessage("m1", "c1", { senderId: 2, sentTimestamp: 200n }) },
			chatMessageId: 0n
		})
		vi.runAllTimers()

		// The message is resident in the chat's cache (the derived count reads it directly), and no scalar
		// query is invalidated — the whole point of the client-derived rework.
		expect(getMessages("c1").some(m => m.uuid === testUuid("m1"))).toBe(true)
		expect(invalidate).not.toHaveBeenCalled()
	})

	it("messageEdited patches content + stamps edited from the Decrypted arm", () => {
		seedMessages("c1", [makeMessage("m1", "c1", { message: "old" })])

		handleChatEvent({
			inner: {
				type: "messageEdited",
				chat: testUuid("c1"),
				uuid: testUuid("m1"),
				newContent: { Decrypted: "new" },
				editedTimestamp: 9n
			},
			chatMessageId: 0n
		})

		expect(getMessages("c1")[0]).toMatchObject({ message: "new", edited: true, editedTimestamp: 9n })
	})

	it("messageEdited skips (and logs) an Encrypted body", () => {
		seedMessages("c1", [makeMessage("m1", "c1", { message: "old" })])

		handleChatEvent({
			inner: {
				type: "messageEdited",
				chat: testUuid("c1"),
				uuid: testUuid("m1"),
				newContent: { Encrypted: "cipher" },
				editedTimestamp: 9n
			},
			chatMessageId: 0n
		})

		expect(getMessages("c1")[0]?.message).toBe("old")
		expect(logWarn).toHaveBeenCalled()
	})

	it("messageDelete finds the owning thread and removes the message", () => {
		seedChats([makeChat("c1")])
		seedMessages("c1", [makeMessage("m1", "c1"), makeMessage("m2", "c1")])

		handleChatEvent({ inner: { type: "messageDelete", uuid: testUuid("m1") }, chatMessageId: 0n })

		expect(getMessages("c1").map(m => m.uuid)).toEqual([testUuid("m2")])
	})

	it("messageEmbedDisabled flips embedDisabled on the matched message", () => {
		seedChats([makeChat("c1")])
		seedMessages("c1", [makeMessage("m1", "c1")])

		handleChatEvent({ inner: { type: "messageEmbedDisabled", uuid: testUuid("m1") }, chatMessageId: 0n })

		expect(getMessages("c1")[0]?.embedDisabled).toBe(true)
	})
})

describe("chat socket handlers — conversations", () => {
	it("conversationsNew upserts the chat into the list", () => {
		seedChats([makeChat("c1")])

		handleChatEvent({ inner: { type: "conversationsNew", chat: makeChat("c2") }, chatMessageId: 0n })

		expect(
			getChats()
				.map(c => c.uuid)
				.sort()
		).toEqual([testUuid("c1"), testUuid("c2")].sort())
	})

	it("conversationNameEdited patches the name from the Decrypted arm", () => {
		seedChats([makeChat("c1", { name: "old" })])

		handleChatEvent({
			inner: { type: "conversationNameEdited", chat: testUuid("c1"), newName: { Decrypted: "new" } },
			chatMessageId: 0n
		})

		expect(getChats()[0]?.name).toBe("new")
	})

	it("conversationParticipantNew adds/replaces a participant", () => {
		seedChats([makeChat("c1", { participants: [participant(1n)] })])

		handleChatEvent({
			inner: { type: "conversationParticipantNew", chat: testUuid("c1"), participant: participant(2n) },
			chatMessageId: 0n
		})

		expect(
			getChats()[0]
				?.participants.map(p => p.userId)
				.sort()
		).toEqual([1n, 2n])
	})

	it("conversationParticipantLeft filters a participant", () => {
		seedChats([makeChat("c1", { participants: [participant(1n), participant(2n)] })])

		handleChatEvent({ inner: { type: "conversationParticipantLeft", uuid: testUuid("c1"), userId: 1n }, chatMessageId: 0n })

		expect(getChats()[0]?.participants.map(p => p.userId)).toEqual([2n])
	})

	it("conversationParticipantLeft for the CURRENT user removes the chat entirely (left from another tab/device)", async () => {
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 1n })
		seedChats([makeChat("c1", { participants: [participant(1n), participant(2n)] }), makeChat("c2")])
		seedMessages("c1", [makeMessage("m1", "c1")])
		setFocusedChat(testUuid("c1"))

		handleChatEvent({ inner: { type: "conversationParticipantLeft", uuid: testUuid("c1"), userId: 1n }, chatMessageId: 0n })

		// The self-removal runs the fire-and-forget conversationDeleted path — flush it.
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(purgeChatInflightState).toHaveBeenCalledWith(testUuid("c1"))
		expect(getChats().map(c => c.uuid)).toEqual([testUuid("c2")])
		expect(getMessages("c1")).toEqual([])
		expect(getFocusedChat()).toBeNull()
	})

	it("conversationParticipantLeft for ANOTHER user only filters the participant, never removes the chat", async () => {
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 1n })
		seedChats([makeChat("c1", { participants: [participant(1n), participant(2n)] })])

		handleChatEvent({ inner: { type: "conversationParticipantLeft", uuid: testUuid("c1"), userId: 2n }, chatMessageId: 0n })

		await new Promise(resolve => setTimeout(resolve, 0))

		expect(purgeChatInflightState).not.toHaveBeenCalled()
		expect(getChats().map(c => c.uuid)).toEqual([testUuid("c1")])
		expect(getChats()[0]?.participants.map(p => p.userId)).toEqual([1n])
	})

	it("conversationDeleted purges FIRST, then removes the chat + clears typing + focus", async () => {
		seedChats([makeChat("c1"), makeChat("c2")])
		seedMessages("c1", [makeMessage("m1", "c1")])
		useChatTypingStore.setState({ typing: { [testUuid("c1")]: [] } })
		setFocusedChat(testUuid("c1"))

		let chatStillPresentWhenPurgeRan = false
		purgeChatInflightState.mockImplementation(() => {
			chatStillPresentWhenPurgeRan = getChats().some(c => c.uuid === testUuid("c1"))

			return Promise.resolve()
		})

		await handleConversationDeleted(testUuid("c1"))

		expect(purgeChatInflightState).toHaveBeenCalledWith(testUuid("c1"))
		expect(chatStillPresentWhenPurgeRan).toBe(true)
		expect(getChats().map(c => c.uuid)).toEqual([testUuid("c2")])
		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toBeUndefined()
		expect(getFocusedChat()).toBeNull()
	})

	it("conversationDeleted cancels a still-pending own-message reconcile timeout — no ghost message-cache slice", async () => {
		vi.useFakeTimers()
		testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: 2n })
		seedChats([makeChat("c1")])
		seedMessages("c1", [])

		// Own send: the reconcile patch is parked for OWN_MESSAGE_RECONCILE_DELAY_MS (3s).
		handleChatEvent({ inner: { type: "messageNew", msg: makeMessage("m1", "c1", { senderId: 2 }) }, chatMessageId: 0n })

		// The chat is deleted well inside that window, before the parked patch has fired.
		vi.advanceTimersByTime(100)
		await handleConversationDeleted(testUuid("c1"))

		// Advance well past the reconcile delay — a cancelled timeout must never recreate the purged slice.
		vi.advanceTimersByTime(5_000)

		expect(getMessages("c1")).toEqual([])
	})
})

describe("chat socket handlers — typing", () => {
	it("a 'down' signal sets a typing user (senderId BigInt-coerced) and 'up' clears it", () => {
		handleChatEvent(typingEvent("c1", 2, "down"))

		const list = useChatTypingStore.getState().typing[testUuid("c1")]
		expect(list?.map(u => u.senderId)).toEqual([2n])

		handleChatEvent(typingEvent("c1", 2, "up"))
		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toBeUndefined()
	})

	it("a repeated 'down' refreshes without duplicating the same sender", () => {
		handleChatEvent(typingEvent("c1", 2, "down"))
		handleChatEvent(typingEvent("c1", 2, "down"))

		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toHaveLength(1)
	})

	it("the expiry watchdog auto-clears a stranded typing user", () => {
		vi.useFakeTimers()
		handleChatEvent(typingEvent("c1", 2, "down"))

		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toHaveLength(1)

		vi.advanceTimersByTime(TYPING_EXPIRY_MS + 1)
		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toBeUndefined()
	})

	it("a messageNew from a typing sender clears their typing state", () => {
		vi.useFakeTimers()
		seedChats([makeChat("c1")])
		seedMessages("c1", [])
		handleChatEvent(typingEvent("c1", 2, "down"))
		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toHaveLength(1)

		handleChatEvent({ inner: { type: "messageNew", msg: makeMessage("m1", "c1", { senderId: 2 }) }, chatMessageId: 0n })
		expect(useChatTypingStore.getState().typing[testUuid("c1")]).toBeUndefined()
	})

	it("SEND: throttles 'down' to one signal per burst, then a single 'up' on stop", async () => {
		const chat = makeChat("send1")

		signalTyping(chat)
		signalTyping(chat)

		await new Promise(resolve => setTimeout(resolve, 5))
		expect(sendTypingSignal).toHaveBeenCalledTimes(1)
		expect(sendTypingSignal).toHaveBeenLastCalledWith(chat, "down")

		signalStopped(chat)
		await new Promise(resolve => setTimeout(resolve, 5))
		expect(sendTypingSignal).toHaveBeenLastCalledWith(chat, "up")
	})

	it("SEND: signalStopped with no outstanding 'down' emits nothing", async () => {
		signalStopped(makeChat("send2"))

		await new Promise(resolve => setTimeout(resolve, 5))
		expect(sendTypingSignal).not.toHaveBeenCalled()
	})
})

describe("chat socket handlers — reconnect", () => {
	it("authSuccess alone (no prior reconnecting) does NOT resync or touch the status indicator", () => {
		useSocketStatusStore.getState().setStatus("connected")

		handleAuthSuccess()

		expect(refetchChatsAndMessages).not.toHaveBeenCalled()
		expect(useSocketStatusStore.getState().status).toBe("connected")
	})

	it("reconnecting flips the disconnect indicator to reconnecting", () => {
		useSocketStatusStore.getState().setStatus("connected")

		handleReconnecting()

		expect(useSocketStatusStore.getState().status).toBe("reconnecting")
	})

	it("a reconnecting → authSuccess pair fires the bulk resync and restores the connected indicator", () => {
		handleReconnecting()
		handleAuthSuccess()

		expect(refetchChatsAndMessages).toHaveBeenCalledOnce()
		expect(useSocketStatusStore.getState().status).toBe("connected")

		// The flag resets — a second authSuccess without a new reconnecting is a no-op.
		refetchChatsAndMessages.mockClear()
		handleAuthSuccess()
		expect(refetchChatsAndMessages).not.toHaveBeenCalled()
	})
})
