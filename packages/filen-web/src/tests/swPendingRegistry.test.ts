import { describe, expect, it } from "vitest"
import { PendingRegistry } from "@/lib/sw/pendingRegistry"

// The service worker's bounded download registry (sw.ts's own state, extracted so it is testable under
// node). What matters: an entry that is still being read — or was read most recently — must survive a
// burst of new registrations, because dropping it 404s a stream mid-playback.

describe("PendingRegistry", () => {
	it("keeps entries until the ceiling is exceeded, then drops the oldest", () => {
		const registry = new PendingRegistry<string>(2)

		registry.set("a", "A")
		registry.set("b", "B")
		registry.set("c", "C")

		expect(registry.size).toBe(2)
		expect(registry.get("a")).toBeUndefined()
		expect(registry.get("b")).toBe("B")
		expect(registry.get("c")).toBe("C")
	})

	it("refreshes recency on read, so a re-read entry is not the next eviction candidate", () => {
		const registry = new PendingRegistry<string>(2)

		registry.set("a", "A")
		registry.set("b", "B")
		registry.get("a")
		registry.set("c", "C")

		expect(registry.get("a")).toBe("A")
		expect(registry.get("b")).toBeUndefined()
	})

	it("never evicts an entry whose stream is still in flight", () => {
		const registry = new PendingRegistry<string>(2)

		registry.set("a", "A")
		registry.beginStream("a")
		registry.set("b", "B")
		registry.set("c", "C")

		expect(registry.get("a")).toBe("A")
		expect(registry.get("b")).toBeUndefined()

		registry.endStream("a")
		registry.set("d", "D")
		registry.set("e", "E")

		// Protection lasts only as long as the stream does.
		expect(registry.get("a")).toBeUndefined()
		expect(registry.get("e")).toBe("E")
	})

	it("keeps a protected entry rather than evicting a streaming one when everything is in flight", () => {
		const registry = new PendingRegistry<string>(1)

		registry.set("a", "A")
		registry.beginStream("a")
		registry.set("b", "B")

		expect(registry.get("a")).toBe("A")
		expect(registry.get("b")).toBe("B")
	})

	it("counts overlapping reads of one id (a range probe alongside the real fetch)", () => {
		const registry = new PendingRegistry<string>(4)

		registry.set("a", "A")
		registry.beginStream("a")
		registry.beginStream("a")

		expect(registry.activeStreams).toBe(2)

		registry.endStream("a")

		expect(registry.activeStreams).toBe(1)

		registry.set("b", "B")
		registry.set("c", "C")
		registry.set("d", "D")
		registry.set("e", "E")

		// Still streaming under the second read → still protected.
		expect(registry.get("a")).toBe("A")

		registry.endStream("a")

		expect(registry.activeStreams).toBe(0)
	})

	it("clears every entry on logout while in-flight pumps keep their own count", () => {
		const registry = new PendingRegistry<string>(4)

		registry.set("a", "A")
		registry.beginStream("a")
		registry.clear()

		expect(registry.size).toBe(0)
		expect(registry.get("a")).toBeUndefined()
		// The pump still holds its SDK handle and settles on its own — the update gate must stay closed.
		expect(registry.activeStreams).toBe(1)

		registry.endStream("a")

		expect(registry.activeStreams).toBe(0)
	})
})
