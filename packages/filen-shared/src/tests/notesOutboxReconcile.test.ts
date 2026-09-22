import { describe, it, expect } from "vitest"
import { pruneAndRebaseNoteOutboxAfterPush, reconcileNoteOutboxAgainstCloud, type InflightContent } from "@filen/shared"

// Plain object standing in for each app's own generated Note type — neither function under test
// ever reads a field off it, only carries it through.
type TestNote = { uuid: string }

const note: TestNote = { uuid: "note-1" }

describe("pruneAndRebaseNoteOutboxAfterPush", () => {
	it("returns undefined for undefined input (nothing to prune)", () => {
		expect(pruneAndRebaseNoteOutboxAfterPush(undefined, 100, "hash")).toBeUndefined()
	})

	it("drops entries typed at or before the pushed entry's LOCAL timestamp (none survive → undefined)", () => {
		const entries = [
			{ timestamp: 100, content: "pushed", note },
			{ timestamp: 50, content: "older", note }
		]

		expect(pruneAndRebaseNoteOutboxAfterPush(entries, 100, "hash")).toBeUndefined()
	})

	it("keeps entries typed strictly after the pushed entry's LOCAL timestamp", () => {
		const entries = [
			{ timestamp: 100, content: "pushed", note },
			{ timestamp: 150, content: "typed-during-round-trip", note }
		]

		const remaining = pruneAndRebaseNoteOutboxAfterPush(entries, 100, "hash")

		expect(remaining).toHaveLength(1)
		expect(remaining?.[0]?.content).toBe("typed-during-round-trip")
	})

	it("never consults a server/edited timestamp — only the local `timestamp` field the caller passes", () => {
		// A survivor carries its own unrelated fields; the prune only ever compares against the
		// `syncedUpTo` argument the caller supplies (the pushed entry's LOCAL author-time).
		const entries = [{ timestamp: 200, content: "typed-after", note, editedTimestamp: 1 }]

		const remaining = pruneAndRebaseNoteOutboxAfterPush(entries, 100, "hash")

		expect(remaining).toHaveLength(1)
	})

	it("rebases every survivor's baseContentHash onto the just-pushed content hash", () => {
		const entries = [
			{ timestamp: 150, content: "v2", note, baseContentHash: "stale-base" },
			{ timestamp: 160, content: "v3", note }
		]

		const remaining = pruneAndRebaseNoteOutboxAfterPush(entries, 100, "pushed-hash")

		expect(remaining?.every(c => c.baseContentHash === "pushed-hash")).toBe(true)
	})

	it("returns undefined (delete signal) when nothing survives the prune", () => {
		const entries = [{ timestamp: 100, content: "pushed", note }]

		expect(pruneAndRebaseNoteOutboxAfterPush(entries, 100, "hash")).toBeUndefined()
	})
})

describe("reconcileNoteOutboxAgainstCloud", () => {
	it("drops an entry whose note no longer exists in the cloud", () => {
		const current: InflightContent<TestNote> = { a: [{ timestamp: 10, content: "x", note }] }

		const updated = reconcileNoteOutboxAgainstCloud(current, ["a"], new Set(), new Map())

		expect(updated["a"]).toBeUndefined()
	})

	it("drops an entry whose content already equals the fetched cloud content (already synced)", () => {
		const current: InflightContent<TestNote> = { a: [{ timestamp: 10, content: "synced", note }] }

		const updated = reconcileNoteOutboxAgainstCloud(current, ["a"], new Set(["a"]), new Map([["a", "synced"]]))

		expect(updated["a"]).toBeUndefined()
	})

	it("keeps an entry whose content differs from the cloud content, regardless of the cloud's edited-timestamp", () => {
		const current: InflightContent<TestNote> = { a: [{ timestamp: 10, content: "unsynced-draft", note }] }

		// No editedTimestamp field is ever consulted here — content comparison only.
		const updated = reconcileNoteOutboxAgainstCloud(current, ["a"], new Set(["a"]), new Map([["a", "cloud-content"]]))

		expect(updated["a"]?.[0]?.content).toBe("unsynced-draft")
	})

	it("leaves entries untouched when the cloud content for that note is unavailable (failed/skipped fetch)", () => {
		const current: InflightContent<TestNote> = { a: [{ timestamp: 10, content: "unsynced-draft", note }] }

		// "a" exists in the cloud but its content fetch never populated cloudContentByUuid.
		const updated = reconcileNoteOutboxAgainstCloud(current, ["a"], new Set(["a"]), new Map())

		expect(updated["a"]?.[0]?.content).toBe("unsynced-draft")
	})

	it("only prunes keys named in fromDiskKeys, leaving other current entries untouched", () => {
		const current: InflightContent<TestNote> = {
			a: [{ timestamp: 10, content: "disk-seeded", note }],
			other: [{ timestamp: 20, content: "not-restored-this-pass", note }]
		}

		const updated = reconcileNoteOutboxAgainstCloud(current, ["a"], new Set(), new Map())

		expect(updated["a"]).toBeUndefined()
		expect(updated["other"]?.[0]?.content).toBe("not-restored-this-pass")
	})

	it("deletes the key entirely (not an empty array) once every entry is pruned", () => {
		const current: InflightContent<TestNote> = { a: [{ timestamp: 10, content: "synced", note }] }

		const updated = reconcileNoteOutboxAgainstCloud(current, ["a"], new Set(["a"]), new Map([["a", "synced"]]))

		expect("a" in updated).toBe(false)
	})
})
