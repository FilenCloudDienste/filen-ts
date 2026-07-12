import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatParticipant, Contact, UserInfo, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const { createChatOp, renameChatOp, muteChatOp, leaveChatOp, deleteChatOp, markChatReadOp, updateLastChatFocusTimesNowOp } = vi.hoisted(
	() => ({
		createChatOp: vi.fn(),
		renameChatOp: vi.fn(),
		muteChatOp: vi.fn(),
		leaveChatOp: vi.fn(),
		deleteChatOp: vi.fn(),
		markChatReadOp: vi.fn(),
		updateLastChatFocusTimesNowOp: vi.fn()
	})
)

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		createChat: createChatOp,
		renameChat: renameChatOp,
		muteChat: muteChatOp,
		leaveChat: leaveChatOp,
		deleteChat: deleteChatOp,
		markChatRead: markChatReadOp,
		updateLastChatFocusTimesNow: updateLastChatFocusTimesNowOp
	}
}))

const { purgeChatInflightStateMock } = vi.hoisted(() => ({ purgeChatInflightStateMock: vi.fn().mockResolvedValue(undefined) }))

vi.mock("@/features/chats/lib/inflight", () => ({ purgeChatInflightState: purgeChatInflightStateMock }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { CHATS_QUERY_KEY, chatsQueryGet } from "@/features/chats/queries/chats"
import { CHATS_UNREAD_QUERY_KEY } from "@/features/chats/queries/chatsUnread"
import { chatMessagesQueryKey } from "@/features/chats/queries/chatMessages"
import {
	isChatOwner,
	createChat as createChatAction,
	renameChat,
	setChatMuted,
	leaveChat,
	deleteChat,
	markChatRead
} from "@/features/chats/lib/actions"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockParticipant(overrides: Partial<ChatParticipant> = {}): ChatParticipant {
	return {
		userId: 2n,
		email: "p@x.io",
		nickName: undefined,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n,
		...overrides
	}
}

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		participants: [mockParticipant()],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: testUuid("contact"),
		userId: 2n,
		email: "c@x.io",
		nickName: "c",
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "",
		...overrides
	}
}

function setCurrentUser(id: bigint): void {
	testQueryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { id } as UserInfo)
}

describe("isChatOwner", () => {
	it("is true when the given userId matches the chat's ownerId", () => {
		expect(isChatOwner(mockChat({ ownerId: 5n }), 5n)).toBe(true)
	})

	it("is false when the given userId does not match", () => {
		expect(isChatOwner(mockChat({ ownerId: 5n }), 6n)).toBe(false)
	})

	it("is false when userId is undefined (no resolved account yet)", () => {
		expect(isChatOwner(mockChat({ ownerId: 5n }), undefined)).toBe(false)
	})
})

describe("createChat", () => {
	it("never calls the SDK with an empty contact list — returns an error outcome", async () => {
		const outcome = await createChatAction([])

		expect(outcome.status).toBe("error")
		expect(createChatOp).not.toHaveBeenCalled()
	})

	it("creates and upserts into the chats-list cache", async () => {
		const chat = mockChat()
		const contact = mockContact()
		createChatOp.mockResolvedValueOnce(chat)

		const outcome = await createChatAction([contact])

		expect(createChatOp).toHaveBeenCalledExactlyOnceWith([contact])
		expect(outcome).toEqual({ status: "success", item: chat })
		expect(chatsQueryGet()).toEqual([chat])
	})

	it("returns an error outcome on rejection, without touching the cache", async () => {
		createChatOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await createChatAction([mockContact()])

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
	it("fires updateLastChatFocusTimesNow and markChatRead together, upserting the refreshed chat", async () => {
		const chat = mockChat({ lastFocus: 0n })
		const refreshed = { ...chat, lastFocus: 1_000n }
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([refreshed])
		markChatReadOp.mockResolvedValueOnce(undefined)

		const outcome = await markChatRead(chat)

		expect(updateLastChatFocusTimesNowOp).toHaveBeenCalledExactlyOnceWith([chat])
		expect(markChatReadOp).toHaveBeenCalledExactlyOnceWith(chat)
		expect(outcome).toEqual({ status: "success" })
		expect(chatsQueryGet()).toEqual([refreshed])
	})

	it("decrements the rail badge by invalidating the unread scalar so it refetches the server's recount", async () => {
		const chat = mockChat({ lastFocus: 0n })
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([chat])
		markChatReadOp.mockResolvedValueOnce(undefined)
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		await markChatRead(chat)

		expect(invalidate).toHaveBeenCalledWith({ queryKey: CHATS_UNREAD_QUERY_KEY })
	})

	it("returns an error outcome when either call rejects", async () => {
		updateLastChatFocusTimesNowOp.mockResolvedValueOnce([mockChat()])
		markChatReadOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await markChatRead(mockChat())

		expect(outcome.status).toBe("error")
	})
})
