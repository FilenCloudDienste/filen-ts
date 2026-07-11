import { afterEach, describe, expect, it, vi } from "vitest"
import type { SocketEvent } from "@filen/sdk-rs"

// The real sdk client imports a Vite `?worker` (unresolvable under node vitest) — mock it to the two
// socket ops the bridge calls.
const { subscribeToSocket, unsubscribeFromSocket } = vi.hoisted(() => ({
	subscribeToSocket: vi.fn<(cb: (event: SocketEvent) => void) => Promise<void>>(() => Promise.resolve()),
	unsubscribeFromSocket: vi.fn<() => void>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { subscribeToSocket, unsubscribeFromSocket } }))

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { error: logError, warn: logWarn, info: vi.fn(), debug: vi.fn() } }))

import { registerSocketHandler, decryptedOrSkip, socketBridge } from "@/lib/sdk/socket"

// Grab the plain dispatch fn the bridge handed to subscribeToSocket (Comlink.proxy is a no-op marker in
// node, so the value passed IS the dispatch closure — invoking it drives the fan-out).
function dispatchFn(): (event: SocketEvent) => void {
	const call = subscribeToSocket.mock.calls.at(-1)

	if (call === undefined) {
		throw new Error("subscribeToSocket was never called")
	}

	return call[0]
}

function noteEvent(uuid: string): SocketEvent {
	return {
		type: "note",
		inner: { type: "new", note: uuid as never },
		noteMessageId: 0n
	}
}

afterEach(async () => {
	await socketBridge.stop()
	vi.clearAllMocks()
})

describe("socket bridge — registry dispatch", () => {
	it("routes an event to the handler registered for its type", async () => {
		const handler = vi.fn()
		const unregister = registerSocketHandler("note", handler)

		await socketBridge.start()
		dispatchFn()(noteEvent("n1"))

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith(noteEvent("n1"))

		unregister()
	})

	it("ignores an event whose type has no registered handler (no throw)", async () => {
		const handler = vi.fn()
		const unregister = registerSocketHandler("note", handler)

		await socketBridge.start()

		const driveEvent: SocketEvent = { type: "drive", inner: { type: "trashEmpty" }, driveMessageId: 0n }

		expect(() => {
			dispatchFn()(driveEvent)
		}).not.toThrow()
		expect(handler).not.toHaveBeenCalled()

		unregister()
	})

	it("does not dispatch to a handler after it unregisters", async () => {
		const handler = vi.fn()
		const unregister = registerSocketHandler("note", handler)

		await socketBridge.start()
		unregister()
		dispatchFn()(noteEvent("n1"))

		expect(handler).not.toHaveBeenCalled()
	})

	it("isolates a throwing handler — the fan-out continues and the throw is logged", async () => {
		const throwing = vi.fn(() => {
			throw new Error("boom")
		})
		const ok = vi.fn()
		const u1 = registerSocketHandler("note", throwing)
		const u2 = registerSocketHandler("note", ok)

		await socketBridge.start()
		dispatchFn()(noteEvent("n1"))

		expect(ok).toHaveBeenCalledTimes(1)
		expect(logError).toHaveBeenCalled()

		u1()
		u2()
	})
})

describe("socket bridge — Decrypted guard", () => {
	it("returns the Decrypted arm's value", () => {
		expect(decryptedOrSkip({ Decrypted: "hello" }, "ctx")).toBe("hello")
		expect(logWarn).not.toHaveBeenCalled()
	})

	it("skips (returns undefined) and logs on the Encrypted arm", () => {
		expect(decryptedOrSkip({ Encrypted: "cipher" }, "note titleEdited")).toBeUndefined()
		expect(logWarn).toHaveBeenCalledTimes(1)
	})
})

describe("socket bridge — lifecycle", () => {
	it("subscribes exactly once across repeated start() calls", async () => {
		await socketBridge.start()
		await socketBridge.start()

		expect(subscribeToSocket).toHaveBeenCalledTimes(1)
	})

	it("unsubscribes on stop() and re-subscribes on a later start()", async () => {
		await socketBridge.start()
		await socketBridge.stop()

		expect(unsubscribeFromSocket).toHaveBeenCalledTimes(1)

		await socketBridge.start()

		expect(subscribeToSocket).toHaveBeenCalledTimes(2)
	})

	it("stop() before any start() is a no-op", async () => {
		await socketBridge.stop()

		expect(unsubscribeFromSocket).not.toHaveBeenCalled()
	})
})
