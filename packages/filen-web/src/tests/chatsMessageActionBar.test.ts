import { describe, expect, it } from "vitest"
import type { ChatMessage, UuidStr } from "@filen/sdk-rs"
import { messageMenuActions, type MessageActionId } from "@/features/chats/components/thread/messageMenu.logic"
import { inlinePrimaryActions, INLINE_PRIMARY } from "@/features/chats/components/thread/messageActionBar.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		uuid: testUuid("msg"),
		senderId: 1,
		senderEmail: "a@example.com",
		senderNickName: undefined,
		message: "hello",
		chat: testUuid("chat"),
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		...overrides
	}
}

function ids(descriptors: { id: MessageActionId }[]): MessageActionId[] {
	return descriptors.map(descriptor => descriptor.id)
}

// The hover action bar renders inlinePrimaryActions(messageMenuActions(...)) as its inline icons and the
// FULL messageMenuActions list behind its ⋯ overflow — so asserting the projection against the same
// descriptor list the right-click menu uses covers exactly what the bar shows per message state.
describe("inlinePrimaryActions (hover action bar)", () => {
	const self = 1n
	const other = 2n

	it("surfaces Reply/Copy/Edit for a confirmed own message", () => {
		const descriptors = messageMenuActions(mockMessage({ senderId: 1 }), self, "confirmed")

		expect(ids(inlinePrimaryActions(descriptors))).toEqual(["reply", "copy", "edit"])
	})

	it("surfaces Reply/Copy for a confirmed message from someone else", () => {
		const descriptors = messageMenuActions(mockMessage({ senderId: 2 }), self, "confirmed")

		// Edit is sender-only; the inline set drops it. Block stays behind the overflow (never inline).
		expect(ids(inlinePrimaryActions(descriptors))).toEqual(["reply", "copy"])
	})

	it("surfaces only Retry for a failed send (Reply/Edit are confirmed-only)", () => {
		const descriptors = messageMenuActions(mockMessage({ senderId: 1 }), self, "failed")

		expect(ids(inlinePrimaryActions(descriptors))).toEqual(["copy", "retry"])
	})

	it("surfaces only Copy for a pending send", () => {
		const descriptors = messageMenuActions(mockMessage({ senderId: 1 }), self, "pending")

		expect(ids(inlinePrimaryActions(descriptors))).toEqual(["copy"])
	})

	it("never surfaces a destructive or low-frequency action inline", () => {
		const ownConfirmed = messageMenuActions(
			mockMessage({ senderId: 1, embedDisabled: false, message: "https://filen.io/f/x" }),
			self,
			"confirmed",
			true
		)
		const inline = ids(inlinePrimaryActions(ownConfirmed))

		expect(inline).not.toContain("delete")
		expect(inline).not.toContain("remove")
		expect(inline).not.toContain("block")
		expect(inline).not.toContain("disableEmbed")
	})

	it("is always a subset of the full menu, preserving descriptor identity", () => {
		for (const message of [mockMessage({ senderId: 1 }), mockMessage({ senderId: 2 })]) {
			for (const currentUserId of [self, other, undefined]) {
				const full = messageMenuActions(message, currentUserId, "confirmed")
				const inline = inlinePrimaryActions(full)

				for (const descriptor of inline) {
					expect(full).toContain(descriptor)
					expect(INLINE_PRIMARY).toContain(descriptor.id)
				}
			}
		}
	})
})
