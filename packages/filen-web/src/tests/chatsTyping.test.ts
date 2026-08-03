import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Chat, UuidStr } from "@filen/sdk-rs"

// typing.ts imports the real sdk client (a Vite `?worker`, unresolvable under node) and the log module —
// mock both at the boundary, same posture as chatsUnreadLogic.test.ts.
const { sendTypingSignalOp } = vi.hoisted(() => ({ sendTypingSignalOp: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendTypingSignal: sendTypingSignalOp } }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { signalStopped, signalTyping } from "@/features/chats/lib/typing"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// typing.ts keeps its per-chat send state in a module-global Map with no reset, and vitest evaluates the
// module once per file — so every case builds its own chat uuid to get a virgin TypingSendState.
function mockChat(label: string): Chat {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n
	}
}

// emitSignal rides a Semaphore whose acquire() resolves as a promise MICROtask — fake timers do not drive
// those, so a flush is needed before asserting: one turn for the .then callback, one for the await inside.
async function flushSignals(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

function signalTypes(): string[] {
	return sendTypingSignalOp.mock.calls.map(call => String(call[1]))
}

beforeEach(() => {
	vi.useFakeTimers()
	sendTypingSignalOp.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("signalTyping / signalStopped cadence", () => {
	it("emits exactly one down on the first keystroke", async () => {
		signalTyping(mockChat("typing1"))
		await flushSignals()

		expect(signalTypes()).toEqual(["down"])
	})

	it("throttles a second keystroke inside the down window to no extra signal", async () => {
		const chat = mockChat("typing2")

		signalTyping(chat)
		await vi.advanceTimersByTimeAsync(500)
		signalTyping(chat)
		await flushSignals()

		expect(signalTypes()).toEqual(["down"])
	})

	// The assertion that pins the 3s idle-up constant.
	it("emits the idle up at 3 000 ms, not before", async () => {
		const chat = mockChat("typing3")

		signalTyping(chat)
		await vi.advanceTimersByTimeAsync(2_999)

		expect(signalTypes()).toEqual(["down"])

		await vi.advanceTimersByTimeAsync(1)

		expect(signalTypes()).toEqual(["down", "up"])
	})

	it("re-arms the idle timer on a later keystroke", async () => {
		const chat = mockChat("typing4")

		signalTyping(chat)
		await vi.advanceTimersByTimeAsync(2_000)
		signalTyping(chat)
		await vi.advanceTimersByTimeAsync(1_000)

		expect(signalTypes()).not.toContain("up")

		await vi.advanceTimersByTimeAsync(2_000)

		expect(signalTypes()).toContain("up")
	})

	// signalStopped resets lastDownAt, so there is no throttle-induced dead window before the next down.
	it("emits up on an explicit stop and lets the next keystroke emit a down immediately", async () => {
		const chat = mockChat("typing5")

		signalTyping(chat)
		signalStopped(chat)
		await flushSignals()

		expect(signalTypes()).toEqual(["down", "up"])

		signalTyping(chat)
		await flushSignals()

		expect(signalTypes()).toEqual(["down", "up", "down"])
	})

	it("emits nothing when stopping with no outstanding down", async () => {
		signalStopped(mockChat("typing6"))
		await flushSignals()

		expect(sendTypingSignalOp).not.toHaveBeenCalled()
	})
})
