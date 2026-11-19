import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Chat } from "@filen/sdk-rs"
import { contactDisplayName, deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"

// typing.ts imports the real sdk client (a Vite `?worker`, unresolvable under node) and the log module —
// mock both at the boundary, same posture as chatsUnreadLogic.test.ts.
const { sendTypingSignalOp } = vi.hoisted(() => ({ sendTypingSignalOp: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendTypingSignal: sendTypingSignalOp } }))

import { signalStopped, signalTyping, typingUserName, visibleTypingUsers } from "@/features/chats/lib/typing"
import type { ChatTypingUser } from "@/features/chats/store/useChatTyping"
import { testUuid } from "@/tests/support/uuid"

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

function typingUser(senderId: bigint, senderEmail: string, senderNickName = ""): ChatTypingUser {
	return { senderId, senderEmail, senderNickName, senderAvatar: undefined, timestamp: 0n }
}

describe("visibleTypingUsers", () => {
	const me = typingUser(1n, "me@filen.io")
	const mallory = typingUser(2n, "mallory@filen.io", "M")
	const bob = typingUser(3n, "bob@filen.io")

	it("drops the current user", () => {
		expect(visibleTypingUsers([me, bob], 1n, EMPTY_BLOCKED_USERS)).toEqual([bob])
	})

	it("withholds a typist blocked by user id", () => {
		const blocked = deriveBlockedUsers([{ userId: 2n, email: "other@filen.io" }])

		expect(visibleTypingUsers([mallory, bob], 1n, blocked)).toEqual([bob])
	})

	it("withholds a typist blocked by email only", () => {
		const blocked = { userIds: new Set<bigint>(), emails: new Set(["mallory@filen.io"]) }

		expect(visibleTypingUsers([mallory, bob], undefined, blocked)).toEqual([bob])
	})

	it("shows the typist again once unblocked, without a new signal", () => {
		const users = [mallory, bob]
		const blocked = deriveBlockedUsers([{ userId: 2n, email: "mallory@filen.io" }])

		expect(visibleTypingUsers(users, 1n, blocked)).toEqual([bob])
		expect(visibleTypingUsers(users, 1n, EMPTY_BLOCKED_USERS)).toEqual([mallory, bob])
	})
})

describe("typingUserName", () => {
	it("follows contactDisplayName for nickname and email-only users", () => {
		const nicknamed = typingUser(2n, "mallory@filen.io", "M")
		const emailOnly = typingUser(3n, "bob@filen.io")

		expect(typingUserName(nicknamed)).toBe(contactDisplayName({ email: "mallory@filen.io", nickName: "M" }))
		expect(typingUserName(emailOnly)).toBe(contactDisplayName({ email: "bob@filen.io", nickName: "" }))
		expect(typingUserName(emailOnly)).toBe("bob@filen.io")
	})
})
