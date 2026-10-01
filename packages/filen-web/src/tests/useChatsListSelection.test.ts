// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useChatsListSelection } from "@/features/chats/hooks/useChatsListSelection"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import { clickEvent, describeClickSelectionContract } from "@/tests/contracts/selection"
import { testUuid } from "@/tests/support/uuid"
import { mockChat } from "@/tests/fixtures/sdk"

const chatA = mockChat({ uuid: testUuid("a") })
const chatB = mockChat({ uuid: testUuid("b") })
const chats = [chatA, chatB, mockChat({ uuid: testUuid("c") }), mockChat({ uuid: testUuid("d") }), mockChat({ uuid: testUuid("e") })]

beforeEach(() => {
	useChatsSelectionStore.setState({ selectedChats: [] })
})

describeClickSelectionContract({
	items: chats,
	render: () =>
		renderHook(() => useChatsListSelection({ chats, selectionCount: useChatsSelectionStore(state => state.selectedChats.length) })).result,
	selected: () => useChatsSelectionStore.getState().selectedChats,
	seed: selectedChats => {
		useChatsSelectionStore.setState({ selectedChats })
	}
})

describe("useChatsListSelection — unmount auto-clear", () => {
	it("unmounting clears the selection — the web equivalent of mobile's List-screen blur", () => {
		const { result, unmount } = renderHook(() => useChatsListSelection({ chats, selectionCount: 0 }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }), "mouse")
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ ctrlKey: true }), "mouse")
		})
		expect(useChatsSelectionStore.getState().selectedChats).toEqual([chatA, chatB])

		unmount()

		expect(useChatsSelectionStore.getState().selectedChats).toEqual([])
	})
})
