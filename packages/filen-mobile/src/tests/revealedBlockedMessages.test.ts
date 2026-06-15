import { describe, it, expect, beforeEach } from "vitest"
import useRevealedBlockedMessages from "@/features/chats/store/useRevealedBlockedMessages.store"

beforeEach(() => {
	useRevealedBlockedMessages.getState().clear()
})

describe("useRevealedBlockedMessages", () => {
	it("reveals a message uuid", () => {
		useRevealedBlockedMessages.getState().reveal("m1")

		expect(useRevealedBlockedMessages.getState().revealed.has("m1")).toBe(true)
	})

	it("clear() empties the set", () => {
		useRevealedBlockedMessages.getState().reveal("m1")
		useRevealedBlockedMessages.getState().clear()

		expect(useRevealedBlockedMessages.getState().revealed.size).toBe(0)
	})
})
