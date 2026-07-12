import { beforeEach, describe, expect, it } from "vitest"
import type { Chat, UuidStr } from "@filen/sdk-rs"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Selection logic is keyed only by uuid, so a minimal fixture is enough — mirrors
// useNotesSelectionStore.test.ts's own mockNote() rationale.
function mockChat(uuid: UuidStr): Chat {
	return {
		uuid,
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n
	}
}

beforeEach(() => {
	useChatsSelectionStore.setState({ selectedChats: [] })
})

describe("toggleSelectedChat", () => {
	it("adds a chat that is not yet selected", () => {
		const chat = mockChat(testUuid("a"))

		useChatsSelectionStore.getState().toggleSelectedChat(chat)

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chat])
	})

	it("removes an already-selected chat, matched by uuid", () => {
		const chat = mockChat(testUuid("a"))

		useChatsSelectionStore.setState({ selectedChats: [chat] })
		useChatsSelectionStore.getState().toggleSelectedChat(chat)

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})

	it("toggling the same chat twice restores the original selection", () => {
		const chat = mockChat(testUuid("a"))

		useChatsSelectionStore.getState().toggleSelectedChat(chat)
		useChatsSelectionStore.getState().toggleSelectedChat(chat)

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})

	it("does not mutate the previous array (returns a new reference)", () => {
		const prev = useChatsSelectionStore.getState().selectedChats

		useChatsSelectionStore.getState().toggleSelectedChat(mockChat(testUuid("a")))

		expect(useChatsSelectionStore.getState().selectedChats).not.toBe(prev)
	})

	it("only affects the matching uuid, leaving other selected chats untouched", () => {
		const chatA = mockChat(testUuid("a"))
		const chatB = mockChat(testUuid("b"))

		useChatsSelectionStore.setState({ selectedChats: [chatA, chatB] })
		useChatsSelectionStore.getState().toggleSelectedChat(chatA)

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatB])
	})
})

describe("setSelectedChats", () => {
	it("accepts a plain array and replaces the selection", () => {
		const chat = mockChat(testUuid("a"))

		useChatsSelectionStore.getState().setSelectedChats([chat])

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chat])
	})

	it("accepts an updater function that reads the previous selection", () => {
		const chatA = mockChat(testUuid("a"))
		const chatB = mockChat(testUuid("b"))

		useChatsSelectionStore.setState({ selectedChats: [chatA] })
		useChatsSelectionStore.getState().setSelectedChats(prev => [...prev, chatB])

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatA, chatB])
	})
})

describe("removeFromSelection", () => {
	it("removes only the given uuids", () => {
		const chatA = mockChat(testUuid("a"))
		const chatB = mockChat(testUuid("b"))

		useChatsSelectionStore.setState({ selectedChats: [chatA, chatB] })
		useChatsSelectionStore.getState().removeFromSelection([testUuid("a")])

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatB])
	})

	it("is a no-op (same array reference) when none of the given uuids are selected", () => {
		const chatA = mockChat(testUuid("a"))

		useChatsSelectionStore.setState({ selectedChats: [chatA] })

		const prev = useChatsSelectionStore.getState().selectedChats

		useChatsSelectionStore.getState().removeFromSelection([testUuid("z")])

		expect(useChatsSelectionStore.getState().selectedChats).toBe(prev)
	})
})

describe("clearSelectedChats", () => {
	it("empties a non-empty selection", () => {
		useChatsSelectionStore.setState({ selectedChats: [mockChat(testUuid("a"))] })
		useChatsSelectionStore.getState().clearSelectedChats()

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})
})
