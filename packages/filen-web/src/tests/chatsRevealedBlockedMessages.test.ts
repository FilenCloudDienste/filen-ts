import { beforeEach, describe, expect, it } from "vitest"
import { useRevealedBlockedMessages } from "@/features/chats/store/useRevealedBlockedMessages"

beforeEach(() => {
	useRevealedBlockedMessages.getState().clear()
})

describe("useRevealedBlockedMessages", () => {
	it("reveal puts the uuid in the set", () => {
		useRevealedBlockedMessages.getState().reveal("a")

		expect(useRevealedBlockedMessages.getState().revealed.has("a")).toBe(true)
	})

	// Re-revealing must not produce a new state object, or every subscriber re-renders for nothing.
	it("re-revealing an already-revealed uuid returns the identical state object", () => {
		useRevealedBlockedMessages.getState().reveal("a")
		const before = useRevealedBlockedMessages.getState()

		useRevealedBlockedMessages.getState().reveal("a")

		expect(useRevealedBlockedMessages.getState()).toBe(before)
	})

	it("revealing a second uuid keeps the first", () => {
		useRevealedBlockedMessages.getState().reveal("a")
		useRevealedBlockedMessages.getState().reveal("b")

		const { revealed } = useRevealedBlockedMessages.getState()
		expect([...revealed].sort()).toEqual(["a", "b"])
	})

	it("clear empties the set", () => {
		useRevealedBlockedMessages.getState().reveal("a")
		useRevealedBlockedMessages.getState().clear()

		expect(useRevealedBlockedMessages.getState().revealed.size).toBe(0)
	})
})
