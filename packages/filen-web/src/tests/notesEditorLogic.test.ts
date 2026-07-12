import { describe, expect, it } from "vitest"
import type { Note } from "@filen/sdk-rs"
import type { InflightEntry } from "@/features/notes/store/useNotesInflight"
import {
	MAX_NOTE_SIZE,
	noteContentByteSize,
	exceedsNoteSizeCap,
	latestInflightContent,
	deriveEditorSeed,
	deriveEditorRemountKey,
	deriveEditorReadOnly,
	deriveEditorLoadState,
	deriveSessionBaseHash,
	reducePersistFailureNotice
} from "@/features/notes/hooks/useNoteEditor.logic"
import { hashNoteContent } from "@/features/notes/lib/sync.logic"

// Same mockNote shape as notesSort.test.ts / notesReaderLogic.test.ts.
function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "00000000-0000-0000-0000-000000000000",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function entry(content: string, timestamp: number): InflightEntry {
	return { content, timestamp, note: mockNote() }
}

describe("latestInflightContent", () => {
	it("returns null for an absent or empty entry list", () => {
		expect(latestInflightContent(undefined)).toBeNull()
		expect(latestInflightContent([])).toBeNull()
	})

	it("returns the content of the newest entry by local author-time", () => {
		// Deliberately out of order — the freshest is picked by timestamp, not array position.
		expect(latestInflightContent([entry("older", 10), entry("newest", 30), entry("mid", 20)])).toBe("newest")
	})
})

describe("deriveEditorSeed — seed priority", () => {
	it("prefers the inflight (unsynced) content over the query's data", () => {
		// The reload-with-inflight case: a disk-restored edit must win over stale pre-edit server content.
		expect(deriveEditorSeed({ inflightLatest: "unsynced local", queryContent: "stale server" })).toBe("unsynced local")
	})

	it("falls through to the query's content when there is no inflight", () => {
		expect(deriveEditorSeed({ inflightLatest: null, queryContent: "server content" })).toBe("server content")
	})

	it("falls through to the empty string when neither source has content (fresh note)", () => {
		expect(deriveEditorSeed({ inflightLatest: null, queryContent: undefined })).toBe("")
	})

	it("treats an EMPTY inflight string as real content that still beats the query (not a falsy fallthrough)", () => {
		// A user who cleared a note's text has an inflight "" — it must seed as "", never revert to server.
		expect(deriveEditorSeed({ inflightLatest: "", queryContent: "old server text" })).toBe("")
	})
})

describe("size cap gating", () => {
	it("MAX_NOTE_SIZE is the old-web 1 MiB minus 64-byte envelope headroom", () => {
		expect(MAX_NOTE_SIZE).toBe(1024 * 1024 - 64)
	})

	it("measures UTF-8 byte length, not JS string length", () => {
		// A 2-byte character counts as 2 toward the cap.
		expect(noteContentByteSize("a")).toBe(1)
		expect(noteContentByteSize("é")).toBe(2)
		expect(noteContentByteSize("😀")).toBe(4)
	})

	it("does not flag content at exactly the cap", () => {
		expect(exceedsNoteSizeCap("a".repeat(MAX_NOTE_SIZE))).toBe(false)
	})

	it("flags content one byte past the cap", () => {
		expect(exceedsNoteSizeCap("a".repeat(MAX_NOTE_SIZE + 1))).toBe(true)
	})

	it("counts multibyte content by bytes, so fewer characters can still exceed the cap", () => {
		// Half as many 2-byte chars as the byte cap → exactly one byte over.
		const chars = "é".repeat(MAX_NOTE_SIZE / 2 + 1)

		expect(chars.length).toBeLessThan(MAX_NOTE_SIZE)
		expect(exceedsNoteSizeCap(chars)).toBe(true)
	})
})

describe("deriveEditorRemountKey", () => {
	it("composes uuid and dataUpdatedAt so either change forces a reseed", () => {
		expect(deriveEditorRemountKey({ uuid: "abc", dataUpdatedAt: 42 })).toBe("abc:42")
	})

	it("is stable for a fixed uuid + dataUpdatedAt (the frozen-mid-session case)", () => {
		const a = deriveEditorRemountKey({ uuid: "u", dataUpdatedAt: 100 })
		const b = deriveEditorRemountKey({ uuid: "u", dataUpdatedAt: 100 })

		expect(a).toBe(b)
	})

	it("changes when the fetch generation (dataUpdatedAt) advances for the same note", () => {
		expect(deriveEditorRemountKey({ uuid: "u", dataUpdatedAt: 100 })).not.toBe(
			deriveEditorRemountKey({ uuid: "u", dataUpdatedAt: 200 })
		)
	})
})

describe("deriveEditorReadOnly", () => {
	it("is read-only for a trashed note", () => {
		expect(deriveEditorReadOnly(mockNote({ trash: true }))).toBe(true)
	})

	it("is writable for an active (non-trashed) note", () => {
		expect(deriveEditorReadOnly(mockNote({ trash: false }))).toBe(false)
	})
})

describe("deriveEditorLoadState", () => {
	it("is always ready when the note has inflight content, even while the query is pending", () => {
		// The disabled-while-inflight query never resolves — but we have a seed to render.
		expect(deriveEditorLoadState({ hasInflight: true, queryStatus: "pending" })).toBe("ready")
		expect(deriveEditorLoadState({ hasInflight: true, queryStatus: "error" })).toBe("ready")
	})

	it("surfaces the query's pending/error only when there is no inflight", () => {
		expect(deriveEditorLoadState({ hasInflight: false, queryStatus: "pending" })).toBe("pending")
		expect(deriveEditorLoadState({ hasInflight: false, queryStatus: "error" })).toBe("error")
	})

	it("is ready once the query resolves with no inflight", () => {
		expect(deriveEditorLoadState({ hasInflight: false, queryStatus: "ready" })).toBe("ready")
	})
})

describe("deriveSessionBaseHash — renews across a full drain, holds steady mid-session", () => {
	it("seeds the base from the mount content when no session is ongoing", () => {
		expect(deriveSessionBaseHash({ seed: "A", hasInflight: false, current: null })).toBe(hashNoteContent("A"))
	})

	it("holds the base steady while a session is inflight (never claims a sync point mid-edit)", () => {
		const base = hashNoteContent("A")

		// The seed reads back the user's own unsynced text mid-session — the base must NOT move to it.
		expect(deriveSessionBaseHash({ seed: "v1", hasInflight: true, current: base })).toBe(base)
	})

	it("renews the base to the just-synced content on the drain edge even when the seed is byte-unchanged", () => {
		const mountBase = hashNoteContent("A")

		// After a full drain the push writes the synced content ("v1") back into the cache, so the seed
		// the hook recomputes is "v1" with hasInflight now false. The base MUST advance to hash("v1"),
		// not stay frozen at the mount base — the frozen value is what fired the false overwrite alarm.
		const drained = deriveSessionBaseHash({ seed: "v1", hasInflight: false, current: mountBase })

		expect(drained).toBe(hashNoteContent("v1"))
		expect(drained).not.toBe(mountBase)
	})
})

describe("reducePersistFailureNotice — one warning per failure streak, re-arms on success", () => {
	it("warns on the first failure only, staying silent through a sustained streak", () => {
		let notified = false
		let warnings = 0

		// Ten failing keystrokes in a row.
		for (let i = 0; i < 10; i++) {
			const notice = reducePersistFailureNotice({ persisted: false, alreadyNotified: notified })

			notified = notice.notified

			if (notice.warn) {
				warnings++
			}
		}

		expect(warnings).toBe(1)
		expect(notified).toBe(true)
	})

	it("re-arms after a persist succeeds so a later failure is surfaced again", () => {
		const first = reducePersistFailureNotice({ persisted: false, alreadyNotified: false })

		expect(first.warn).toBe(true)

		const recovered = reducePersistFailureNotice({ persisted: true, alreadyNotified: first.notified })

		expect(recovered.notified).toBe(false)
		expect(recovered.warn).toBe(false)

		const again = reducePersistFailureNotice({ persisted: false, alreadyNotified: recovered.notified })

		expect(again.warn).toBe(true)
	})
})
