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

import { filterNotesByBlockedOwner, filterNotesMarkedOffline, filterNotesShared } from "@/features/notes/utils"
import { deriveBlockedUsers } from "@/features/contacts/blockedSelectors"
import { type Note } from "@/types"

const blocked = deriveBlockedUsers([{ uuid: "x", userId: 99n, email: "b@x.com", avatar: undefined, nickName: "B", timestamp: 0n }] as never)

function note(ownerId: bigint, uuid: string): Note {
	return { uuid, ownerId, participants: [] } as unknown as Note
}

const ME = 1n

// The owner is IN participants (NoteParticipant carries isOwner), so these mirror what the SDK hands
// back rather than a convenient shape.
function sharedNote(uuid: string, ownerId: bigint, participantIds: bigint[]): Note {
	return {
		uuid,
		ownerId,
		participants: participantIds.map(userId => ({ userId, isOwner: userId === ownerId }))
	} as unknown as Note
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

describe("filterNotesShared", () => {
	it("keeps a note you own and shared with someone else", () => {
		const notes = [sharedNote("out", ME, [ME, 7n])]

		expect(filterNotesShared(notes, ME).map(n => n.uuid)).toEqual(["out"])
	})

	it("keeps a note somebody else shared with you", () => {
		// The direction the ownerId test alone would answer backwards: you are not the owner here.
		const notes = [sharedNote("in", 7n, [7n, ME])]

		expect(filterNotesShared(notes, ME).map(n => n.uuid)).toEqual(["in"])
	})

	it("drops a note that is yours alone", () => {
		// The owner sits in participants, so an unshared note still has one entry — which is exactly
		// why the predicate asks "is anyone here who is not me" rather than counting participants.
		expect(filterNotesShared([sharedNote("solo", ME, [ME])], ME)).toEqual([])
	})

	it("drops an unshared note whichever way the SDK reports its participants", () => {
		// Some payloads carry an empty participant list for a note nobody else touches.
		expect(filterNotesShared([sharedNote("solo", ME, [])], ME)).toEqual([])
	})

	it("keeps both directions together — one view, not two", () => {
		const notes = [sharedNote("out", ME, [ME, 7n]), sharedNote("solo", ME, [ME]), sharedNote("in", 7n, [7n, ME])]

		expect(filterNotesShared(notes, ME).map(n => n.uuid)).toEqual(["out", "in"])
	})

	it("classifies nothing without a user id, so the caller can hold the spinner", () => {
		// Returning the full list here would label every note "Shared"; returning [] lets the view
		// distinguish "not answerable yet" from "nothing is shared" (see notesViewModeAwaitsUser).
		expect(filterNotesShared([sharedNote("out", ME, [ME, 7n])], undefined)).toEqual([])
	})

	it("does not mutate the input", () => {
		const notes = [sharedNote("out", ME, [ME, 7n]), sharedNote("solo", ME, [ME])]

		filterNotesShared(notes, ME)

		expect(notes).toHaveLength(2)
	})
})
