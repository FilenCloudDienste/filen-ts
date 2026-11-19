import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage, UserInfo } from "@filen/sdk-rs"

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const {
	createChatOp,
	renameChatOp,
	muteChatOp,
	leaveChatOp,
	deleteChatOp,
	markChatReadOp,
	updateLastChatFocusTimesNowOp,
	addChatParticipantOp,
	removeChatParticipantOp,
	deleteMessageOp
} = vi.hoisted(() => ({
	createChatOp: vi.fn(),
	renameChatOp: vi.fn(),
	muteChatOp: vi.fn(),
	leaveChatOp: vi.fn(),
	deleteChatOp: vi.fn(),
	markChatReadOp: vi.fn(),
	updateLastChatFocusTimesNowOp: vi.fn(),
	addChatParticipantOp: vi.fn(),
	removeChatParticipantOp: vi.fn(),
	deleteMessageOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		createChat: createChatOp,
		renameChat: renameChatOp,
		muteChat: muteChatOp,
		leaveChat: leaveChatOp,
		deleteChat: deleteChatOp,
		markChatRead: markChatReadOp,
		updateLastChatFocusTimesNow: updateLastChatFocusTimesNowOp,
		addChatParticipant: addChatParticipantOp,
		removeChatParticipant: removeChatParticipantOp,
		deleteMessage: deleteMessageOp
	}
}))

const { purgeChatInflightStateMock } = vi.hoisted(() => ({ purgeChatInflightStateMock: vi.fn().mockResolvedValue(undefined) }))

vi.mock("@/features/chats/lib/inflight", () => ({ purgeChatInflightState: purgeChatInflightStateMock }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { CHATS_QUERY_KEY, chatsQueryGet, chatsQueryUpdate } from "@/features/chats/queries/chats"
import { chatMessagesQueryKey } from "@/features/chats/queries/chatMessages"
import { createChat as createChatAction, renameChat, setChatMuted, leaveChat, deleteChat, markChatRead } from "@/features/chats/lib/actions"
import { addChatParticipants, removeChatParticipant } from "@/features/chats/lib/participants"
import { deleteMessage } from "@/features/chats/lib/messageActions"
import { mockPlainContact } from "@/tests/support/contactFixtures"
import { testUuid } from "@/tests/support/uuid"
import { mockChat as fixtureChat, mockChatMessage, mockChatParticipant as mockParticipant } from "@/tests/fixtures/sdk"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return fixtureChat({ participants: [mockParticipant()], ...overrides })
}

function setCurrentUser(id: bigint): void {
	testQueryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { id } as UserInfo)
}

describe("createChat", () => {
	it("never calls the SDK with an empty contact list — returns an error outcome", async () => {
		const outcome = await createChatAction([])

		expect(outcome.status).toBe("error")
		expect(createChatOp).not.toHaveBeenCalled()
	})

	it("creates and upserts into the chats-list cache", async () => {
		const chat = mockChat()
		const contact = mockPlainContact()
		createChatOp.mockResolvedValueOnce(chat)

		const outcome = await createChatAction([contact])

		expect(createChatOp).toHaveBeenCalledExactlyOnceWith([contact])
		expect(outcome).toEqual({ status: "success", item: chat })
		expect(chatsQueryGet()).toEqual([chat])
	})

	it("returns an error outcome on rejection, without touching the cache", async () => {
		createChatOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await createChatAction([mockPlainContact()])

		expect(outcome.status).toBe("error")
		expect(chatsQueryGet()).toBeUndefined()
	})
})

describe("renameChat (owner-gated)", () => {
	it("renames when the current user owns the chat", async () => {
		setCurrentUser(1n)
		const chat = mockChat({ ownerId: 1n, name: "Original" })
		const updated = { ...chat, name: "Renamed" }
		renameChatOp.mockResolvedValueOnce(updated)

		const outcome = await renameChat(chat, "  Renamed  ")

		expect(renameChatOp).toHaveBeenCalledExactlyOnceWith(chat, "Renamed")
		expect(outcome).toEqual({ status: "success", item: updated })
		expect(chatsQueryGet()).toEqual([updated])
	})

	it("refuses without calling the worker when the current user does not own the chat", async () => {
		setCurrentUser(2n)
		const chat = mockChat({ ownerId: 1n })

		const outcome = await renameChat(chat, "Renamed")

		expect(outcome.status).toBe("error")
		expect(renameChatOp).not.toHaveBeenCalled()
	})

	it("no-ops on an empty/whitespace name", async () => {
		setCurrentUser(1n)
		const chat = mockChat({ ownerId: 1n, name: "Original" })

		await expect(renameChat(chat, "   ")).resolves.toEqual({ status: "success", item: chat })
		expect(renameChatOp).not.toHaveBeenCalled()
	})

	it("no-ops when the trimmed name is unchanged", async () => {
		setCurrentUser(1n)
		const chat = mockChat({ ownerId: 1n, name: "Original" })

		await expect(renameChat(chat, "  Original  ")).resolves.toEqual({ status: "success", item: chat })
		expect(renameChatOp).not.toHaveBeenCalled()
	})
})

describe("setChatMuted", () => {
	it("mutes and upserts the resulting chat — not owner-gated (a personal setting)", async () => {
		const chat = mockChat({ ownerId: 1n, muted: false })
		const updated = { ...chat, muted: true }
		muteChatOp.mockResolvedValueOnce(updated)

		const outcome = await setChatMuted(chat, true)

		expect(muteChatOp).toHaveBeenCalledExactlyOnceWith(chat, true)
		expect(outcome).toEqual({ status: "success", item: updated })
	})

	it("no-ops when the requested mute state already matches", async () => {
		const chat = mockChat({ muted: true })

		await expect(setChatMuted(chat, true)).resolves.toEqual({ status: "success", item: chat })
		expect(muteChatOp).not.toHaveBeenCalled()
	})
})

describe("leaveChat", () => {
	it("removes the chat from the cache and purges inflight state on success", async () => {
		const chat = mockChat()
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		leaveChatOp.mockResolvedValueOnce(undefined)

		const outcome = await leaveChat(chat)

		expect(outcome).toEqual({ status: "success" })
		expect(purgeChatInflightStateMock).toHaveBeenCalledExactlyOnceWith(chat.uuid)
		expect(chatsQueryGet()).toEqual([])
	})

	it("calls beforeCacheRemoval AFTER the SDK confirms but BEFORE the cache patch — nav-race guard", async () => {
		const chat = mockChat()
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		const order: string[] = []
		leaveChatOp.mockImplementationOnce(() => {
			order.push("sdk")
			return Promise.resolve(undefined)
		})

		await leaveChat(chat, {
			beforeCacheRemoval: () => {
				order.push("beforeCacheRemoval")
				expect(chatsQueryGet()).toEqual([chat])
			}
		})

		order.push("afterCall")
		expect(order).toEqual(["sdk", "beforeCacheRemoval", "afterCall"])
		expect(chatsQueryGet()).toEqual([])
	})

	it("never calls beforeCacheRemoval and leaves the cache untouched on rejection", async () => {
		const chat = mockChat()
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		leaveChatOp.mockRejectedValueOnce(new Error("fail"))
		const beforeCacheRemoval = vi.fn()

		const outcome = await leaveChat(chat, { beforeCacheRemoval })

		expect(outcome.status).toBe("error")
		expect(beforeCacheRemoval).not.toHaveBeenCalled()
		expect(purgeChatInflightStateMock).not.toHaveBeenCalled()
		expect(chatsQueryGet()).toEqual([chat])
	})
})

describe("deleteChat (owner-gated)", () => {
	it("deletes when the current user owns the chat", async () => {
		setCurrentUser(1n)
		const chat = mockChat({ ownerId: 1n })
		testQueryClient.setQueryData(CHATS_QUERY_KEY, [chat])
		deleteChatOp.mockResolvedValueOnce(undefined)

		const outcome = await deleteChat(chat)

		expect(deleteChatOp).toHaveBeenCalledExactlyOnceWith(chat)
		expect(outcome).toEqual({ status: "success" })
		expect(purgeChatInflightStateMock).toHaveBeenCalledExactlyOnceWith(chat.uuid)
		expect(chatsQueryGet()).toEqual([])
	})

	it("refuses without calling the worker when the current user does not own the chat", async () => {
		setCurrentUser(2n)
		const chat = mockChat({ ownerId: 1n })

		const outcome = await deleteChat(chat)

		expect(outcome.status).toBe("error")
		expect(deleteChatOp).not.toHaveBeenCalled()
		expect(purgeChatInflightStateMock).not.toHaveBeenCalled()
	})

	it("clears the chat's message cache slice on success", async () => {
		setCurrentUser(1n)
		const chat = mockChat({ ownerId: 1n })
		testQueryClient.setQueryData(chatMessagesQueryKey(chat.uuid), ["stale"])
		deleteChatOp.mockResolvedValueOnce(undefined)

		await deleteChat(chat)

		expect(testQueryClient.getQueryData(chatMessagesQueryKey(chat.uuid))).toBeUndefined()
	})
})

describe("markChatRead", () => {
	it("fires updateLastChatFocusTimesNow and markChatRead together, merging the refreshed lastFocus into the cached row", async () => {
		const chat = mockChat({ lastFocus: 0n })
		const refreshed = { ...chat, lastFocus: 1_000n }
		testQueryClient.setQueryData<Chat[]>(CHATS_QUERY_KEY, [chat])
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([refreshed])
		markChatReadOp.mockResolvedValueOnce(undefined)

		const outcome = await markChatRead(chat)

		expect(updateLastChatFocusTimesNowOp).toHaveBeenCalledExactlyOnceWith([chat])
		expect(markChatReadOp).toHaveBeenCalledExactlyOnceWith(chat)
		expect(outcome).toEqual({ status: "success" })
		expect(chatsQueryGet()).toEqual([refreshed])
	})

	it("appends the refreshed chat when the list has no row for it", async () => {
		const chat = mockChat({ lastFocus: 0n })
		const refreshed = { ...chat, lastFocus: 1_000n }
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([refreshed])
		markChatReadOp.mockResolvedValueOnce(undefined)

		await markChatRead(chat)

		expect(chatsQueryGet()).toEqual([refreshed])
	})

	it("writes no unread-side cache invalidation — the derived count self-corrects from the advanced lastFocus", async () => {
		const chat = mockChat({ lastFocus: 0n })
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([chat])
		markChatReadOp.mockResolvedValueOnce(undefined)
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		await markChatRead(chat)

		expect(invalidate).not.toHaveBeenCalled()
	})

	it("returns an error outcome when either call rejects", async () => {
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([mockChat()])
		markChatReadOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await markChatRead(mockChat())

		expect(outcome.status).toBe("error")
	})
})

// A socket event (a new message) patching the row while an action's request is in flight must survive the
// action's resolve: the SDK returns the snapshot the caller passed in, so only the action's own field may land.
describe("action results keep a socket patch made during the request", () => {
	function mockMessage(label: string, sentTimestamp: bigint): ChatMessage {
		return mockChatMessage({ uuid: testUuid(label), senderId: 2, senderEmail: "p@x.io", message: label, sentTimestamp })
	}

	const older = mockMessage("older", 100n)
	const newer = mockMessage("newer", 200n)

	function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
		let resolve: (value: T) => void = () => undefined
		const promise = new Promise<T>(r => {
			resolve = r
		})

		return { promise, resolve }
	}

	// Seeds the row, starts the action, then lands a socket patch (new lastMessage, advanced lastFocus).
	async function withSocketPatch<T>(chat: Chat, start: () => Promise<T>): Promise<() => Promise<T>> {
		testQueryClient.setQueryData<Chat[]>(CHATS_QUERY_KEY, [chat])

		const pending = start()

		await Promise.resolve()
		chatsQueryUpdate(prev => prev.map(c => (c.uuid === chat.uuid ? { ...c, lastMessage: newer, lastFocus: 500n } : c)))

		return () => pending
	}

	function cachedRow(): Chat | undefined {
		return chatsQueryGet()?.[0]
	}

	it("rename applies the name only", async () => {
		setCurrentUser(1n)
		const chat = mockChat({ ownerId: 1n, name: "Original", lastMessage: older })
		const request = deferred<Chat>()
		renameChatOp.mockReturnValueOnce(request.promise)

		const settle = await withSocketPatch(chat, () => renameChat(chat, "Renamed"))

		request.resolve({ ...chat, name: "Renamed" })
		await settle()

		expect(cachedRow()).toEqual({ ...chat, name: "Renamed", lastMessage: newer, lastFocus: 500n })
	})

	it("mute applies muted only", async () => {
		const chat = mockChat({ muted: false, lastMessage: older })
		const request = deferred<Chat>()
		muteChatOp.mockReturnValueOnce(request.promise)

		const settle = await withSocketPatch(chat, () => setChatMuted(chat, true))

		request.resolve({ ...chat, muted: true })
		await settle()

		expect(cachedRow()).toEqual({ ...chat, muted: true, lastMessage: newer, lastFocus: 500n })
	})

	it("mark read applies lastFocus only", async () => {
		const chat = mockChat({ lastFocus: 0n, lastMessage: older })
		const request = deferred<Chat[]>()
		updateLastChatFocusTimesNowOp.mockReturnValueOnce(request.promise)
		markChatReadOp.mockResolvedValueOnce(undefined)

		const settle = await withSocketPatch(chat, () => markChatRead(chat))

		request.resolve([{ ...chat, lastFocus: 1_000n }])
		await settle()

		expect(cachedRow()).toEqual({ ...chat, lastMessage: newer, lastFocus: 1_000n })
	})

	it("mark read never moves lastFocus behind a socket patch that advanced it further", async () => {
		const chat = mockChat({ lastFocus: 0n, lastMessage: older })
		const request = deferred<Chat[]>()
		updateLastChatFocusTimesNowOp.mockReturnValueOnce(request.promise)
		markChatReadOp.mockResolvedValueOnce(undefined)

		const settle = await withSocketPatch(chat, () => markChatRead(chat))

		request.resolve([{ ...chat, lastFocus: 300n }])
		await settle()

		expect(cachedRow()).toEqual({ ...chat, lastMessage: newer, lastFocus: 500n })
	})

	it("adding participants applies the participant list only", async () => {
		const chat = mockChat({ lastMessage: older })
		const contact = mockPlainContact({ userId: 3n })
		const added = mockParticipant({ userId: contact.userId, email: contact.email })
		const request = deferred<Chat>()
		addChatParticipantOp.mockReturnValueOnce(request.promise)

		const settle = await withSocketPatch(chat, () => addChatParticipants(chat, [contact]))

		request.resolve({ ...chat, participants: [...chat.participants, added] })
		await settle()

		expect(cachedRow()).toEqual({ ...chat, participants: [...chat.participants, added], lastMessage: newer, lastFocus: 500n })
	})

	it("removing a participant applies the participant list only", async () => {
		const participant = mockParticipant()
		const chat = mockChat({ participants: [participant], lastMessage: older })
		const request = deferred<Chat>()
		removeChatParticipantOp.mockReturnValueOnce(request.promise)

		const settle = await withSocketPatch(chat, () => removeChatParticipant(chat, participant))

		request.resolve({ ...chat, participants: [] })
		await settle()

		expect(cachedRow()).toEqual({ ...chat, participants: [], lastMessage: newer, lastFocus: 500n })
	})

	it("deleting a message that is no longer the row's lastMessage leaves the row alone", async () => {
		const chat = mockChat({ lastMessage: older })
		const request = deferred<Chat>()
		deleteMessageOp.mockReturnValueOnce(request.promise)

		const settle = await withSocketPatch(chat, () => deleteMessage(chat, older))

		// The SDK's snapshot predates the arrival.
		request.resolve({ ...chat, lastMessage: mockMessage("before-older", 50n) })
		await settle()

		expect(cachedRow()).toEqual({ ...chat, lastMessage: newer, lastFocus: 500n })
	})

	it("deleting the row's lastMessage takes the returned preview and keeps other patched fields", async () => {
		const chat = mockChat({ lastMessage: older })
		const previous = mockMessage("previous", 50n)
		const request = deferred<Chat>()
		deleteMessageOp.mockReturnValueOnce(request.promise)
		testQueryClient.setQueryData<Chat[]>(CHATS_QUERY_KEY, [chat])

		const pending = deleteMessage(chat, older)

		await Promise.resolve()
		chatsQueryUpdate(prev => prev.map(c => ({ ...c, lastFocus: 500n })))
		request.resolve({ ...chat, lastMessage: previous })
		await pending

		expect(cachedRow()).toEqual({ ...chat, lastMessage: previous, lastFocus: 500n })
	})

	it("deleting the only message clears the row's preview", async () => {
		const chat = mockChat({ lastMessage: older })
		const withoutPreview = mockChat()
		deleteMessageOp.mockResolvedValueOnce(withoutPreview)
		testQueryClient.setQueryData<Chat[]>(CHATS_QUERY_KEY, [chat])

		await deleteMessage(chat, older)

		expect(cachedRow()).toEqual(withoutPreview)
		expect(cachedRow()).not.toHaveProperty("lastMessage")
	})
})
