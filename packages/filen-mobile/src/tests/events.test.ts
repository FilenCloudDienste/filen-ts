import { describe, it, expect, beforeEach } from "vitest"

// TypedEventEmitter wraps eventemitter3 — no native deps needed.
// We test the class directly by importing the singleton and exercising its public API.
// No mocks required; eventemitter3 is pure JS.

import events, { type Events } from "@/lib/events"

// Helper: cast to avoid TypeScript complaining about accessing private class members
// when we want a fresh instance per-suite.  We import the singleton and call the
// real methods — we never mock the unit under test.

beforeEach(() => {
	// Remove all listeners so each test starts clean. eventemitter3 exposes
	// removeAllListeners() on the underlying emitter but TypedEventEmitter doesn't
	// forward it.  Work around: re-import the module — but we can't reset module
	// state in vitest without full re-import.  Instead, we unsubscribe explicitly
	// at the end of each test (see per-test teardown below), or we call the
	// underlying emitter if accessible.
	//
	// Safest approach: cast to any and call the internal emitter's removeAllListeners.
	// This keeps test isolation without modifying source.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const internal = (events as any).emitter
	if (internal && typeof internal.removeAllListeners === "function") {
		internal.removeAllListeners()
	}
})

describe("TypedEventEmitter", () => {
	describe("subscribe() + emit() round-trip", () => {
		it("listener receives the correct typed payload", () => {
			const received: string[] = []
			events.subscribe("secureStoreChange", payload => {
				received.push(payload.key)
			})

			events.emit("secureStoreChange", { key: "myKey", value: "hello" })

			expect(received).toEqual(["myKey"])
		})

		it("subscribe().remove() unsubscribes so subsequent emits do not fire", () => {
			const calls: number[] = []
			const sub = events.subscribe("secureStoreChange", () => {
				calls.push(1)
			})

			events.emit("secureStoreChange", { key: "k", value: "v" })
			expect(calls).toHaveLength(1)

			sub.remove()
			events.emit("secureStoreChange", { key: "k", value: "v" })

			expect(calls).toHaveLength(1)
		})
	})

	describe("on() / off()", () => {
		it("on() registers a listener that fires on emit", () => {
			const calls: string[] = []
			const handler = (payload: Events["secureStoreRemove"]) => {
				calls.push(payload.key)
			}

			events.on("secureStoreRemove", handler)
			events.emit("secureStoreRemove", { key: "removed" })

			expect(calls).toEqual(["removed"])
		})

		it("off() with the same reference removes the listener — subsequent emits do not fire", () => {
			const calls: number[] = []
			const handler = () => {
				calls.push(1)
			}

			events.on("secureStoreRemove", handler)
			events.emit("secureStoreRemove", { key: "k" })
			expect(calls).toHaveLength(1)

			events.off("secureStoreRemove", handler)
			events.emit("secureStoreRemove", { key: "k" })

			expect(calls).toHaveLength(1)
		})
	})

	describe("once()", () => {
		it("fires exactly once even when the event is emitted multiple times", () => {
			const calls: number[] = []
			events.once("secureStoreChange", () => {
				calls.push(1)
			})

			events.emit("secureStoreChange", { key: "k", value: "v" })
			events.emit("secureStoreChange", { key: "k", value: "v" })
			events.emit("secureStoreChange", { key: "k", value: "v" })

			expect(calls).toHaveLength(1)
		})
	})

	describe("emit() return value", () => {
		it("returns true when at least one listener is registered", () => {
			const sub = events.subscribe("secureStoreChange", () => {})
			const result = events.emit("secureStoreChange", { key: "k", value: "v" })

			sub.remove()

			expect(result).toBe(true)
		})

		it("returns false when no listeners are registered", () => {
			// beforeEach clears all listeners
			const result = events.emit("secureStoreChange", { key: "k", value: "v" })

			expect(result).toBe(false)
		})
	})

	describe("multiple independent subscribers", () => {
		it("all subscribers on the same event receive the same payload", () => {
			const a: string[] = []
			const b: string[] = []
			const c: string[] = []

			events.subscribe("chatConversationDeleted", p => a.push(p.uuid))
			events.subscribe("chatConversationDeleted", p => b.push(p.uuid))
			events.subscribe("chatConversationDeleted", p => c.push(p.uuid))

			events.emit("chatConversationDeleted", { uuid: "chat-xyz" })

			expect(a).toEqual(["chat-xyz"])
			expect(b).toEqual(["chat-xyz"])
			expect(c).toEqual(["chat-xyz"])
		})
	})

	describe("event isolation", () => {
		it("emitting event A does not trigger a listener registered for event B", () => {
			const aFired: number[] = []
			const bFired: number[] = []

			events.subscribe("secureStoreChange", () => aFired.push(1))
			events.subscribe("secureStoreClear", () => bFired.push(1))

			events.emit("secureStoreChange", { key: "k", value: "v" })

			expect(aFired).toHaveLength(1)
			expect(bFired).toHaveLength(0)
		})
	})

	describe("void-typed events", () => {
		it("can be emitted without payload and listener receives undefined", () => {
			let received: unknown = "NOT_CALLED"
			events.subscribe("showFullScreenLoadingModal", payload => {
				received = payload
			})

			events.emit("showFullScreenLoadingModal")

			// void events carry no payload — listener is called with undefined
			expect(received).toBeUndefined()
		})

		it("hideFullScreenLoadingModal fires without payload", () => {
			let called = false
			events.subscribe("hideFullScreenLoadingModal", () => {
				called = true
			})

			events.emit("hideFullScreenLoadingModal")

			expect(called).toBe(true)
		})
	})
})
