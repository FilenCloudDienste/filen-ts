import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockSendTyping } = vi.hoisted(() => ({ mockSendTyping: vi.fn() }))

vi.mock("@filen/sdk-rs", () => ({
	ChatTypingType: { Up: 0, Down: 1 }
}))
vi.mock("@/features/chats/chats", () => ({
	default: { sendTyping: mockSendTyping }
}))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import { signalStopped, signalTyping } from "@/features/chats/typing"
import logger from "@/lib/logger"
import { ChatTypingType } from "@filen/sdk-rs"
import { type Chat } from "@/types"

// The typing state is module-global, so every case uses its own chat uuid.
function mockChat(uuid: string): Chat {
	return { uuid } as unknown as Chat
}

async function flushSignals(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	mockSendTyping.mockReset()
	mockSendTyping.mockResolvedValue(undefined)
	vi.mocked(logger.warn).mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("chat typing sender", () => {
	it("sends one Down for a keystroke burst, then Up on stop", async () => {
		const chat = mockChat("typing-burst")

		signalTyping(chat)
		signalTyping(chat)
		signalTyping(chat)
		signalStopped(chat)
		await flushSignals()

		expect(mockSendTyping.mock.calls).toEqual([[{ chat, type: ChatTypingType.Down }], [{ chat, type: ChatTypingType.Up }]])
	})

	it("sends nothing when the chat is left without typing", async () => {
		signalStopped(mockChat("typing-none"))
		await flushSignals()

		expect(mockSendTyping).not.toHaveBeenCalled()
	})

	it("logs a failed signal as a warning without throwing", async () => {
		mockSendTyping.mockRejectedValueOnce(new Error("network"))

		signalTyping(mockChat("typing-fail"))
		await flushSignals()

		expect(logger.warn).toHaveBeenCalledWith("chats", "sendTypingEvent failed", { error: expect.any(Error) })
	})
})
