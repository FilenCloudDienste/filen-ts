import { describe, it, expect } from "vitest"
import { hashNoteContent, buildInflightEntries, mergeInflight, type InflightEntry } from "@filen/shared"

// Plain object standing in for each app's own generated Note type — buildInflightEntries/mergeInflight
// never read a field off it, only carry it through.
type TestNote = { uuid: string }

const note: TestNote = { uuid: "note-1" }

describe("hashNoteContent", () => {
	it("is deterministic for the same content", () => {
		expect(hashNoteContent("hello")).toBe(hashNoteContent("hello"))
	})

	it("differs for different content", () => {
		expect(hashNoteContent("hello")).not.toBe(hashNoteContent("world"))
	})
})

describe("buildInflightEntries — monotonic timestamps (NTP-backstep guard)", () => {
	it("stamps `now` for a fresh session", () => {
		const entries = buildInflightEntries({ previous: undefined, note, content: "x", now: 1000, sessionBaseHash: null })

		expect(entries).toHaveLength(1)
		expect(entries[0]?.timestamp).toBe(1000)
		expect(entries[0]?.content).toBe("x")
	})

	it("a forward-moving clock keeps using the wall-clock timestamp", () => {
		const first = buildInflightEntries({ previous: undefined, note, content: "v1", now: 1000, sessionBaseHash: null })
		const second = buildInflightEntries({ previous: first, note, content: "v2", now: 9000, sessionBaseHash: null })

		expect(second[0]?.timestamp).toBe(9000)
		expect(second[0]?.content).toBe("v2")
	})

	it("forces newest+1 when the clock steps backward", () => {
		const previous = [{ timestamp: 5000, content: "old", note }]
		const entries = buildInflightEntries({ previous, note, content: "new", now: 4000, sessionBaseHash: null })

		// now (4000) < newest existing (5000) → monotonic bump to 5001, never the stale 4000.
		expect(entries[0]?.timestamp).toBe(5001)
	})

	it("a backward clock step still lets the newest text win the sync push's max-timestamp pick, and the local-time prune cannot discard it", () => {
		const first = buildInflightEntries({ previous: undefined, note, content: "typed-before-step", now: 5000, sessionBaseHash: null })

		// An NTP correction steps the wall clock BACK mid-editing: Date.now() now yields 3000.
		const second = buildInflightEntries({ previous: first, note, content: "typed-after-step", now: 3000, sessionBaseHash: null })

		const newest = second.reduce((acc, c) => (c.timestamp > acc.timestamp ? c : acc))

		expect(newest.content).toBe("typed-after-step")
		expect(newest.timestamp).toBe(5001)

		// A push's `> syncedUpTo` prune (local-vs-local) removes only superseded entries — nothing
		// stale resurrects behind the newest text.
		const remainingAfterPrune = second.filter(c => c.timestamp > newest.timestamp)

		expect(remainingAfterPrune).toHaveLength(0)
	})

	it("stamps the session base hash only on a FRESH session, carries it forward after", () => {
		const fresh = buildInflightEntries({ previous: undefined, note, content: "x", now: 1, sessionBaseHash: "base1" })

		expect(fresh[0]?.baseContentHash).toBe("base1")

		const next = buildInflightEntries({ previous: fresh, note, content: "y", now: 2, sessionBaseHash: "IGNORED" })

		// An ongoing session carries the existing base, never re-stamps the seed.
		expect(next[0]?.baseContentHash).toBe("base1")
	})

	it("omits the base hash key entirely for the legacy no-hash grace (exactOptionalPropertyTypes)", () => {
		const [first] = buildInflightEntries({ previous: undefined, note, content: "x", now: 1, sessionBaseHash: null })

		expect(first).toBeDefined()
		expect(first !== undefined && "baseContentHash" in first).toBe(false)
	})

	it("a legacy session (existing entries without a hash) stays hash-less — one-pass grace, never mid-session stamping", () => {
		const legacy: InflightEntry<TestNote>[] = [{ timestamp: 1000, content: "restored-from-old-version", note }]
		const next = buildInflightEntries({ previous: legacy, note, content: "v2", now: 2000, sessionBaseHash: "h(now-known)" })

		expect(next[0]?.baseContentHash).toBeUndefined()
	})
})

describe("mergeInflight — replay-on-launch merge semantics (#41)", () => {
	it("seeds uuids the current queue does not have yet", () => {
		const merged = mergeInflight({}, { a: [{ timestamp: 10, content: "disk", note }] })

		expect(merged["a"]?.[0]?.content).toBe("disk")
	})

	it("keeps the current side when its local timestamp is at least as fresh", () => {
		const current = { a: [{ timestamp: 20, content: "typed-during-fetch", note }] }
		const merged = mergeInflight(current, { a: [{ timestamp: 10, content: "stale-disk", note }] })

		expect(merged["a"]?.[0]?.content).toBe("typed-during-fetch")
	})

	it("takes the disk side when it carries the newer local timestamp", () => {
		const current = { a: [{ timestamp: 5, content: "stale-store", note }] }
		const merged = mergeInflight(current, { a: [{ timestamp: 30, content: "newer-disk", note }] })

		expect(merged["a"]?.[0]?.content).toBe("newer-disk")
	})

	it("preserves current-only uuids untouched", () => {
		const current = { other: [{ timestamp: 2000, content: "stays", note }] }
		const fromDisk = { a: [{ timestamp: 1000, content: "disk", note }] }

		const merged = mergeInflight(current, fromDisk)

		expect(merged["other"]?.[0]?.content).toBe("stays")
		expect(merged["a"]?.[0]?.content).toBe("disk")
	})
})
