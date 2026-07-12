// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { MouseEvent as ReactMouseEvent } from "react"
import type { Chat, UuidStr } from "@filen/sdk-rs"
import { useChatsListSelection } from "@/features/chats/hooks/useChatsListSelection"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

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

function clickEvent(modifiers: Partial<Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">> = {}): ReactMouseEvent {
	return { shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers } as ReactMouseEvent
}

const chatA = mockChat(testUuid("a"))
const chatB = mockChat(testUuid("b"))
const chatC = mockChat(testUuid("c"))
const chatD = mockChat(testUuid("d"))
const chatE = mockChat(testUuid("e"))
const chats = [chatA, chatB, chatC, chatD, chatE]

beforeEach(() => {
	useChatsSelectionStore.setState({ selectedChats: [] })
})

describe("useChatsListSelection — plain click", () => {
	it("replaces the selection with just the clicked chat, regardless of prior selection", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ ctrlKey: true }))
		})
		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatA, chatB])

		act(() => {
			result.current.handlePointerSelect(2, clickEvent())
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatC])
	})

	it("is a no-op when the index has no matching chat", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(99, clickEvent())
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})
})

describe("useChatsListSelection — Ctrl/Cmd+click toggles", () => {
	it("adds an unselected chat to the selection", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(2, clickEvent({ metaKey: true }))
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatA, chatC])
	})

	it("removes an already-selected chat, leaving the rest untouched", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ ctrlKey: true }))
		})
		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatA, chatB])

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatB])
	})
})

describe("useChatsListSelection — Shift+click range", () => {
	it("extends a range from the last plain-click/ctrl-click anchor to the shift-clicked index", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(1, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(3, clickEvent({ shiftKey: true }))
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatB, chatC, chatD])
	})

	it("range is ascending regardless of which side (anchor or target) is later in the list", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(3, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ shiftKey: true }))
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatB, chatC, chatD])
	})

	it("a second shift-click re-anchors from the ORIGINAL (non-shift) anchor, not the previous shift target", () => {
		const { result } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(2, clickEvent({ shiftKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(4, clickEvent({ shiftKey: true }))
		})

		expect(useChatsSelectionStore.getState().selectedChats).toEqual(chats)
	})
})

describe("useChatsListSelection — mount/unmount auto-clear", () => {
	it("mounting fresh never inherits a selection already sitting in the store from elsewhere", () => {
		useChatsSelectionStore.setState({ selectedChats: [chatA] })

		renderHook(() => useChatsListSelection({ chats }))

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})

	it("unmounting clears the selection — the web equivalent of mobile's List-screen blur", () => {
		const { result, unmount } = renderHook(() => useChatsListSelection({ chats }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ ctrlKey: true }))
		})
		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatA, chatB])

		unmount()

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})
})
