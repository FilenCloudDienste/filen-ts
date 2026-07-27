import { describe, it, expect, vi } from "vitest"

// notes/utils.ts imports the NoteType enum (a runtime value) from @filen/sdk-rs; mock it.
// Note is a type-only import (erased at runtime).
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}
}))

import { filterNotesByBlockedOwner, filterNotesMarkedOffline } from "@/features/notes/utils"
import { deriveBlockedUsers } from "@/features/contacts/blockedSelectors"
import { type Note } from "@/types"

const blocked = deriveBlockedUsers([{ uuid: "x", userId: 99n, email: "b@x.com", avatar: undefined, nickName: "B", timestamp: 0n }] as never)

function note(ownerId: bigint, uuid: string): Note {
	return { uuid, ownerId, participants: [] } as unknown as Note
}

describe("filterNotesByBlockedOwner", () => {
	it("drops notes owned by a blocked user", () => {
		const result = filterNotesByBlockedOwner([note(99n, "a"), note(5n, "b")], blocked)

		expect(result.map(n => n.uuid)).toEqual(["b"])
	})

	it("keeps your own notes even if a participant is blocked", () => {
		const result = filterNotesByBlockedOwner([note(1n, "mine")], blocked)

		expect(result.map(n => n.uuid)).toEqual(["mine"])
	})
})

describe("filterNotesMarkedOffline", () => {
	it("keeps only the notes the ledger says are kept on the device", () => {
		const result = filterNotesMarkedOffline([note(1n, "a"), note(1n, "b"), note(1n, "c")], { a: true, c: true })

		expect(result.map(n => n.uuid)).toEqual(["a", "c"])
	})

	it("is empty when nothing is marked — the offline view's empty state", () => {
		expect(filterNotesMarkedOffline([note(1n, "a")], {})).toEqual([])
	})

	// Membership is the ledger's, not the note's: a stale entry for a note that is no longer in the
	// list simply matches nothing rather than conjuring a row.
	it("ignores ledger entries with no corresponding note", () => {
		expect(filterNotesMarkedOffline([note(1n, "a")], { a: true, gone: true }).map(n => n.uuid)).toEqual(["a"])
	})

	it("does not mutate the input", () => {
		const notes = [note(1n, "a"), note(1n, "b")]

		filterNotesMarkedOffline(notes, { a: true })

		expect(notes).toHaveLength(2)
	})
})
