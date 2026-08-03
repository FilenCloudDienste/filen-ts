import { describe, expect, it } from "vitest"
import type { Note, NoteParticipant } from "@filen/sdk-rs"
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

function participant(userId: bigint, permissionsWrite: boolean): NoteParticipant {
	return {
		userId,
		isOwner: false,
		email: "participant@example.com",
		nickName: "participant",
		permissionsWrite,
		addedTimestamp: 0n
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

	it("seeds a fresh note whose query resolved the empty string as the empty string", () => {
		expect(deriveEditorSeed({ inflightLatest: null, queryContent: "" })).toBe("")
	})

	it("falls back to the empty string for undefined query content — the pending/failed tail, never a painted state", () => {
		// Both states render before the editor mounts, so this branch is the type-level tail only.
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
		expect(deriveEditorReadOnly(mockNote({ trash: true, ownerId: 1n }), 1n)).toBe(true)
	})

	it("is writable for an active note this user owns", () => {
		expect(deriveEditorReadOnly(mockNote({ trash: false, ownerId: 1n }), 1n)).toBe(false)
	})

	it("is read-only for a shared note whose participant row carries no write permission", () => {
		const note = mockNote({ ownerId: 1n, participants: [participant(7n, false)] })

		expect(deriveEditorReadOnly(note, 7n)).toBe(true)
	})

	it("is writable for a shared note whose participant row carries write permission", () => {
		const note = mockNote({ ownerId: 1n, participants: [participant(7n, true)] })

		expect(deriveEditorReadOnly(note, 7n)).toBe(false)
	})

	it("is read-only when the user id is unresolved (fail-safe)", () => {
		expect(deriveEditorReadOnly(mockNote({ ownerId: 1n }), undefined)).toBe(true)
	})
})

describe("deriveEditorLoadState", () => {
	it("is always ready when the note has inflight content, even while the query is pending", () => {
		// The disabled-while-inflight query never resolves — but we have a seed to render.
		expect(deriveEditorLoadState({ hasInflight: true, outboxHydrated: true, queryStatus: "pending", isUndecryptable: false })).toBe(
			"ready"
		)
		expect(deriveEditorLoadState({ hasInflight: true, outboxHydrated: true, queryStatus: "error", isUndecryptable: false })).toBe(
			"ready"
		)
	})

	it("keeps an inflight edit readable even when the content query failed to decrypt", () => {
		expect(deriveEditorLoadState({ hasInflight: true, outboxHydrated: true, queryStatus: "error", isUndecryptable: true })).toBe(
			"ready"
		)
	})

	it("surfaces the query's pending/error only when there is no inflight", () => {
		expect(deriveEditorLoadState({ hasInflight: false, outboxHydrated: true, queryStatus: "pending", isUndecryptable: false })).toBe(
			"pending"
		)
		expect(deriveEditorLoadState({ hasInflight: false, outboxHydrated: true, queryStatus: "error", isUndecryptable: false })).toBe(
			"error"
		)
	})

	it("narrows an undecryptable-content failure out of the generic error state", () => {
		expect(deriveEditorLoadState({ hasInflight: false, outboxHydrated: true, queryStatus: "error", isUndecryptable: true })).toBe(
			"undecryptable"
		)
	})

	it("is ready once the query resolves with no inflight", () => {
		expect(deriveEditorLoadState({ hasInflight: false, outboxHydrated: true, queryStatus: "ready", isUndecryptable: false })).toBe(
			"ready"
		)
	})

	// The reload race: the outbox restores from disk asynchronously, so an editor that mounts first sees
	// an EMPTY inflight view for a note that DOES have a queued edit. Seeding there paints the server's
	// pre-edit content and, because the seed only re-derives on a remount-key change, never corrects
	// itself — the user's edit is silently lost the moment they type again.
	it("holds the pending state until the outbox has hydrated, whatever the query already resolved", () => {
		expect(deriveEditorLoadState({ hasInflight: false, outboxHydrated: false, queryStatus: "ready", isUndecryptable: false })).toBe(
			"pending"
		)
		expect(deriveEditorLoadState({ hasInflight: false, outboxHydrated: false, queryStatus: "error", isUndecryptable: true })).toBe(
			"pending"
		)
	})

	it("releases the gate the instant the outbox hydrates, with the inflight-first rule intact", () => {
		expect(deriveEditorLoadState({ hasInflight: true, outboxHydrated: false, queryStatus: "ready", isUndecryptable: false })).toBe(
			"pending"
		)
		expect(deriveEditorLoadState({ hasInflight: true, outboxHydrated: true, queryStatus: "ready", isUndecryptable: false })).toBe(
			"ready"
		)
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
