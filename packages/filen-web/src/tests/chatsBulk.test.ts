import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatParticipant, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching chatsActions.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const { muteChatOp, leaveChatOp, deleteChatOp, markChatReadOp, updateLastChatFocusTimesNowOp } = vi.hoisted(() => ({
	muteChatOp: vi.fn(),
	leaveChatOp: vi.fn(),
	deleteChatOp: vi.fn(),
	markChatReadOp: vi.fn(),
	updateLastChatFocusTimesNowOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
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
import { chatsQueryGet } from "@/features/chats/queries/chats"
import { markChatsRead, setChatsMuted, deleteChatsPermanently, leaveChats } from "@/features/chats/lib/bulk"

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

function setCurrentUser(id: bigint): void {
	testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id })
}

describe("markChatsRead — fans out per selected chat", () => {
	it("calls both SDK ops per chat and upserts the refreshed chat into the cache", async () => {
		const chatA = mockChat({ uuid: testUuid("a") })
		const chatB = mockChat({ uuid: testUuid("b") })
		updateLastChatFocusTimesNowOp.mockImplementation((chats: Chat[]) => Promise.resolve(chats.map(c => ({ ...c, lastFocus: 999n }))))
		markChatReadOp.mockResolvedValue(undefined)

		const outcome = await markChatsRead([chatA, chatB])

		expect(updateLastChatFocusTimesNowOp).toHaveBeenCalledTimes(2)
		expect(markChatReadOp).toHaveBeenCalledTimes(2)
		expect(outcome.succeeded).toHaveLength(2)
		expect(outcome.failed).toHaveLength(0)
	})

	it("a rejected chat lands in `failed`, others still succeed", async () => {
		const okChat = mockChat({ uuid: testUuid("a") })
		const failChat = mockChat({ uuid: testUuid("b") })
		updateLastChatFocusTimesNowOp.mockImplementation((chats: Chat[]) =>
			chats[0]?.uuid === failChat.uuid ? Promise.reject(new Error("network")) : Promise.resolve(chats)
		)
		markChatReadOp.mockResolvedValue(undefined)

		const outcome = await markChatsRead([okChat, failChat])

		expect(outcome.succeeded).toEqual([okChat])
		expect(outcome.failed).toHaveLength(1)
		expect(outcome.failed[0]?.item).toBe(failChat)
	})
})

describe("setChatsMuted — explicit-target dispatch", () => {
	it("drives every selected chat to the SAME target value, not each chat's own opposite", async () => {
		const muted = mockChat({ uuid: testUuid("a"), muted: true })
		const alreadyUnmuted = mockChat({ uuid: testUuid("b"), muted: false })
		muteChatOp.mockImplementation((chat: Chat, mute: boolean) => Promise.resolve({ ...chat, muted: mute }))

		await setChatsMuted([muted, alreadyUnmuted], false)

		// `muted` differs from the target (false) — setChatMuted's guard lets it through to the SDK.
		expect(muteChatOp).toHaveBeenCalledWith(muted, false)
		// `alreadyUnmuted` already matches the target — setChatMuted's own idempotency guard no-ops it
		// before ever reaching the SDK.
		expect(muteChatOp).not.toHaveBeenCalledWith(alreadyUnmuted, expect.anything())
	})

	it("fans out to every selected chat and upserts the results into the cache", async () => {
		const chatA = mockChat({ uuid: testUuid("a"), muted: false })
		const chatB = mockChat({ uuid: testUuid("b"), muted: false })
		muteChatOp.mockImplementation((chat: Chat) => Promise.resolve({ ...chat, muted: true }))

		const outcome = await setChatsMuted([chatA, chatB], true)

		expect(outcome.succeeded).toHaveLength(2)
		expect(outcome.failed).toHaveLength(0)
		expect(chatsQueryGet()).toEqual(
			expect.arrayContaining([
				{ ...chatA, muted: true },
				{ ...chatB, muted: true }
			])
		)
	})
})

describe("deleteChatsPermanently — owner gate + per-chat beforeCacheRemoval", () => {
	it("fires beforeCacheRemoval once per successfully deleted chat", async () => {
		setCurrentUser(1n)
		const chatA = mockChat({ uuid: testUuid("a"), ownerId: 1n })
		const chatB = mockChat({ uuid: testUuid("b"), ownerId: 1n })
		deleteChatOp.mockResolvedValue(undefined)
		const beforeCacheRemoval = vi.fn()

		await deleteChatsPermanently([chatA, chatB], { beforeCacheRemoval })

		expect(beforeCacheRemoval).toHaveBeenCalledWith(chatA)
		expect(beforeCacheRemoval).toHaveBeenCalledWith(chatB)
		expect(beforeCacheRemoval).toHaveBeenCalledTimes(2)
	})

	it("a non-owned chat fails the item (no crash), owned ones still succeed", async () => {
		setCurrentUser(1n)
		const owned = mockChat({ uuid: testUuid("a"), ownerId: 1n })
		const notOwned = mockChat({ uuid: testUuid("b"), ownerId: 2n })
		deleteChatOp.mockResolvedValue(undefined)

		const outcome = await deleteChatsPermanently([owned, notOwned])

		expect(outcome.succeeded).toEqual([owned])
		expect(outcome.failed).toHaveLength(1)
		expect(outcome.failed[0]?.item).toBe(notOwned)
		expect(deleteChatOp).toHaveBeenCalledExactlyOnceWith(owned)
	})
})

describe("leaveChats — non-owner self-remove, per-chat beforeCacheRemoval", () => {
	it("calls leaveChat per selected chat and fires beforeCacheRemoval for each", async () => {
		const chatA = mockChat({ uuid: testUuid("a") })
		const chatB = mockChat({ uuid: testUuid("b") })
		leaveChatOp.mockResolvedValue(undefined)
		const beforeCacheRemoval = vi.fn()

		const outcome = await leaveChats([chatA, chatB], { beforeCacheRemoval })

		expect(leaveChatOp).toHaveBeenCalledTimes(2)
		expect(beforeCacheRemoval).toHaveBeenCalledWith(chatA)
		expect(beforeCacheRemoval).toHaveBeenCalledWith(chatB)
		expect(outcome.succeeded).toEqual([chatA, chatB])
	})
})
