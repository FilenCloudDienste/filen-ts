import { describe, expect, it } from "vitest"
import { segmentMessage } from "@filen/shared"
import { messageAddressing } from "@/features/chats/lib/mentions.logic"
import { mockChatMessage, mockChatParticipant } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

const ME = 7n
const participants = [
	mockChatParticipant({ userId: ME, email: "me@filen.io" }),
	mockChatParticipant({ userId: 2n, email: "other@filen.io" })
]

function addressingFor(userId: bigint | undefined, text: string, overrides: Parameters<typeof mockChatMessage>[0] = {}) {
	const message = mockChatMessage({ senderId: 2, message: text, ...overrides })

	return messageAddressing(message, segmentMessage(message.message), participants, userId)
}

function addressing(text: string, overrides: Parameters<typeof mockChatMessage>[0] = {}) {
	return addressingFor(ME, text, overrides)
}

describe("messageAddressing", () => {
	it("flags an @mention of the reader's email", () => {
		expect(addressing("hey @me@filen.io look")).toBe("mention")
	})

	it("matches the email case-insensitively", () => {
		expect(addressing("hey @Me@Filen.io")).toBe("mention")
	})

	it("flags @everyone", () => {
		expect(addressing("@everyone meeting")).toBe("mention")
	})

	it("ignores a mention of someone else", () => {
		expect(addressing("hey @other@filen.io")).toBeNull()
	})

	it("ignores a mention inside a code block", () => {
		expect(addressing("```@me@filen.io```")).toBeNull()
	})

	it("flags a reply to one of the reader's messages", () => {
		const replyTo = { uuid: testUuid("r"), senderId: Number(ME), senderEmail: "me@filen.io", senderNickName: undefined, message: "q" }

		expect(addressing("answer", { replyTo })).toBe("reply")
	})

	it("prefers the mention when a reply also mentions the reader", () => {
		const replyTo = { uuid: testUuid("r"), senderId: Number(ME), senderEmail: "me@filen.io", senderNickName: undefined, message: "q" }

		expect(addressing("@me@filen.io answer", { replyTo })).toBe("mention")
	})

	it("never flags the reader's own message", () => {
		expect(addressing("@everyone hi", { senderId: Number(ME) })).toBeNull()
	})

	it("flags nothing without a signed-in user", () => {
		expect(addressingFor(undefined, "@everyone hi")).toBeNull()
	})

	it("needs the reader among the participants for an email mention", () => {
		const message = mockChatMessage({ senderId: 2, message: "@me@filen.io" })

		expect(messageAddressing(message, segmentMessage(message.message), [], ME)).toBeNull()
	})
})
