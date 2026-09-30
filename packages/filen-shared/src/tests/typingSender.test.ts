import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTypingSender, TYPING_DOWN_THROTTLE_MS, TYPING_IDLE_UP_MS, type TypingSignal } from "@filen/shared"

type TestChat = { uuid: string }

function setup(send: (chat: TestChat, type: TypingSignal) => Promise<void> = async () => {}) {
	const calls: [string, TypingSignal][] = []
	const onError = vi.fn()
	const sender = createTypingSender<TestChat>({
		keyOf: chat => chat.uuid,
		send: async (chat, type) => {
			calls.push([chat.uuid, type])

			await send(chat, type)
		},
		onError
	})

	return { ...sender, calls, onError, types: () => calls.map(([, type]) => type) }
}

// Sends ride a Semaphore whose acquire() resolves as a microtask, which fake timers do not drive.
async function flushSignals(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("createTypingSender", () => {
	it("pins the web/mobile cadence constants", () => {
		expect(TYPING_DOWN_THROTTLE_MS).toBe(2_500)
		expect(TYPING_IDLE_UP_MS).toBe(3_000)
	})

	it("emits exactly one down on the first keystroke", async () => {
		const s = setup()

		s.signalTyping({ uuid: "a" })
		await flushSignals()

		expect(s.types()).toEqual(["down"])
	})

	it("throttles keystrokes inside the down window, then emits another down after it", async () => {
		const s = setup()
		const chat = { uuid: "a" }

		s.signalTyping(chat)
		await vi.advanceTimersByTimeAsync(500)
		s.signalTyping(chat)
		await vi.advanceTimersByTimeAsync(1_000)
		s.signalTyping(chat)
		await flushSignals()

		expect(s.types()).toEqual(["down"])

		await vi.advanceTimersByTimeAsync(1_000)
		s.signalTyping(chat)
		await flushSignals()

		expect(s.types()).toEqual(["down", "down"])
	})

	it("emits the idle up at 3 000 ms, not before", async () => {
		const s = setup()

		s.signalTyping({ uuid: "a" })
		await vi.advanceTimersByTimeAsync(2_999)

		expect(s.types()).toEqual(["down"])

		await vi.advanceTimersByTimeAsync(1)

		expect(s.types()).toEqual(["down", "up"])
	})

	it("re-arms the idle timer on a later keystroke", async () => {
		const s = setup()
		const chat = { uuid: "a" }

		s.signalTyping(chat)
		await vi.advanceTimersByTimeAsync(2_000)
		s.signalTyping(chat)
		await vi.advanceTimersByTimeAsync(1_000)

		expect(s.types()).not.toContain("up")

		await vi.advanceTimersByTimeAsync(2_000)

		expect(s.types()).toEqual(["down", "up"])
	})

	it("emits up on an explicit stop, cancels the idle up, and lets the next keystroke emit a down immediately", async () => {
		const s = setup()
		const chat = { uuid: "a" }

		s.signalTyping(chat)
		s.signalStopped(chat)
		await flushSignals()

		expect(s.types()).toEqual(["down", "up"])

		s.signalTyping(chat)
		await flushSignals()

		expect(s.types()).toEqual(["down", "up", "down"])

		s.signalStopped(chat)
		await vi.advanceTimersByTimeAsync(TYPING_IDLE_UP_MS * 2)

		expect(s.types()).toEqual(["down", "up", "down", "up"])
	})

	it("emits nothing when stopping with no outstanding down", async () => {
		const s = setup()
		const chat = { uuid: "a" }

		s.signalStopped(chat)
		s.signalStopped(chat)
		await flushSignals()

		expect(s.calls).toEqual([])
	})

	it("keeps per-chat state independent", async () => {
		const s = setup()

		s.signalTyping({ uuid: "a" })
		s.signalTyping({ uuid: "b" })
		s.signalStopped({ uuid: "b" })
		await flushSignals()

		expect(s.calls).toEqual([
			["a", "down"],
			["b", "down"],
			["b", "up"]
		])
	})

	it("keys state by keyOf, so a replaced chat object keeps its outstanding down", async () => {
		const s = setup()

		s.signalTyping({ uuid: "a" })
		s.signalStopped({ uuid: "a" })
		await flushSignals()

		expect(s.types()).toEqual(["down", "up"])
	})

	it("serializes sends so an up never overtakes its down", async () => {
		let releaseDown: () => void = () => {}
		const s = setup(
			(_chat, type) =>
				new Promise<void>(resolve => {
					if (type === "down") {
						releaseDown = resolve

						return
					}

					resolve()
				})
		)
		const chat = { uuid: "a" }

		s.signalTyping(chat)
		s.signalStopped(chat)
		await flushSignals()

		expect(s.types()).toEqual(["down"])

		releaseDown()
		await flushSignals()

		expect(s.types()).toEqual(["down", "up"])
	})

	it("routes a failed send to onError and keeps sending later signals", async () => {
		const error = new Error("network")
		const s = setup(async (_chat, type) => {
			if (type === "down") {
				throw error
			}
		})
		const chat = { uuid: "a" }

		s.signalTyping(chat)
		await flushSignals()

		expect(s.onError).toHaveBeenCalledWith(chat, "down", error)

		s.signalStopped(chat)
		await flushSignals()

		expect(s.types()).toEqual(["down", "up"])
		expect(s.onError).toHaveBeenCalledOnce()
	})
})
