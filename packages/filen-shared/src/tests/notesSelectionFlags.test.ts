import { describe, it, expect } from "vitest"
import { aggregateNoteSelectionFlags, hasNoteWriteAccess, isNoteOwner } from "@filen/shared"

type TestNote = {
	favorite: boolean
	pinned: boolean
	archive: boolean
	trash: boolean
	undecryptable: boolean
	ownerId: bigint
	participants: readonly { userId: bigint; permissionsWrite: boolean }[]
}

const ME = 1n
const SOMEONE_ELSE = 2n

function note(overrides: Partial<TestNote> = {}): TestNote {
	return {
		favorite: false,
		pinned: false,
		archive: false,
		trash: false,
		undecryptable: false,
		ownerId: ME,
		participants: [],
		...overrides
	}
}

function participant(userId: bigint, permissionsWrite: boolean): { userId: bigint; permissionsWrite: boolean } {
	return { userId, permissionsWrite }
}

// One app stamps this at fetch time, the other derives it from a decryption-key check — the
// injected predicate is what lets the aggregator stay agnostic to which. Plain `n.undecryptable`
// stands in for both here.
const isUndecryptable = (n: TestNote): boolean => n.undecryptable

describe("aggregateNoteSelectionFlags", () => {
	const EMPTY = aggregateNoteSelectionFlags([], ME, isUndecryptable)

	it("returns the shared empty-flags constant when selection is empty", () => {
		expect(aggregateNoteSelectionFlags([], ME, isUndecryptable)).toBe(EMPTY)
	})

	it("returns the shared empty-flags constant when userId is undefined", () => {
		expect(aggregateNoteSelectionFlags([note()], undefined, isUndecryptable)).toBe(EMPTY)
	})

	it("the empty-flags constant is frozen", () => {
		expect(Object.isFrozen(EMPTY)).toBe(true)
	})

	it("counts selected notes", () => {
		const flags = aggregateNoteSelectionFlags([note(), note(), note()], ME, isUndecryptable)

		expect(flags.count).toBe(3)
	})

	it("includesFavorited true when any note is favorited", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ favorite: true })], ME, isUndecryptable).includesFavorited).toBe(true)
	})

	it("includesFavorited false when no note is favorited", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).includesFavorited).toBe(false)
	})

	it("includesPinned mirrors any-pinned", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ pinned: true })], ME, isUndecryptable).includesPinned).toBe(true)
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).includesPinned).toBe(false)
	})

	it("includesTrashed mirrors any-trashed", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ trash: true })], ME, isUndecryptable).includesTrashed).toBe(true)
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).includesTrashed).toBe(false)
	})

	it("includesArchived true when any note is archived", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ archive: true })], ME, isUndecryptable).includesArchived).toBe(true)
	})

	it("includesArchived false when no note is archived", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).includesArchived).toBe(false)
	})

	it("includesUndecryptable true when any note is undecryptable", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ undecryptable: true })], ME, isUndecryptable).includesUndecryptable).toBe(
			true
		)
	})

	it("includesUndecryptable false when no note is undecryptable", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).includesUndecryptable).toBe(false)
	})

	it("everyOwned true only when current user owns every note", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).everyOwned).toBe(true)
		expect(aggregateNoteSelectionFlags([note(), note({ ownerId: SOMEONE_ELSE })], ME, isUndecryptable).everyOwned).toBe(false)
	})

	it("everyTrashed true only when every note is trashed", () => {
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note({ trash: true })], ME, isUndecryptable).everyTrashed).toBe(
			true
		)
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note()], ME, isUndecryptable).everyTrashed).toBe(false)
	})

	it("everyArchivedOrTrashed true when every note is archived or trashed", () => {
		expect(
			aggregateNoteSelectionFlags([note({ archive: true }), note({ archive: true })], ME, isUndecryptable).everyArchivedOrTrashed
		).toBe(true)
		expect(
			aggregateNoteSelectionFlags([note({ trash: true }), note({ trash: true })], ME, isUndecryptable).everyArchivedOrTrashed
		).toBe(true)
		expect(
			aggregateNoteSelectionFlags([note({ archive: true }), note({ trash: true })], ME, isUndecryptable).everyArchivedOrTrashed
		).toBe(true)
	})

	it("everyArchivedOrTrashed false when any note is active", () => {
		expect(aggregateNoteSelectionFlags([note({ archive: true }), note()], ME, isUndecryptable).everyArchivedOrTrashed).toBe(
			false
		)
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note()], ME, isUndecryptable).everyArchivedOrTrashed).toBe(false)
	})

	it("hasWriteAccessToAll: owner of all has write", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable).hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll: participant with write counts as write", () => {
		const shared = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })

		expect(aggregateNoteSelectionFlags([shared], ME, isUndecryptable).hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll: participant read-only does not count as write", () => {
		const shared = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })

		expect(aggregateNoteSelectionFlags([shared], ME, isUndecryptable).hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll: mixed write + read-only is false", () => {
		const writeable = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })
		const readOnly = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })

		expect(aggregateNoteSelectionFlags([writeable, readOnly], ME, isUndecryptable).hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll: owner has write regardless of an empty participants list", () => {
		const owned = note({ ownerId: ME, participants: [] })

		expect(aggregateNoteSelectionFlags([owned], ME, isUndecryptable).hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll: false when user is not on an empty participants list and not the owner", () => {
		const unshared = note({ ownerId: SOMEONE_ELSE, participants: [] })

		expect(aggregateNoteSelectionFlags([unshared], ME, isUndecryptable).hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll: false when user is not a participant and not the owner", () => {
		const stranger = note({ ownerId: SOMEONE_ELSE, participants: [participant(SOMEONE_ELSE + 1n, true)] })

		expect(aggregateNoteSelectionFlags([stranger], ME, isUndecryptable).hasWriteAccessToAll).toBe(false)
	})

	it("participantOfEveryAndNotOwner: true only if user is participant + not owner of ALL", () => {
		const participated = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })

		expect(
			aggregateNoteSelectionFlags([participated, participated], ME, isUndecryptable).participantOfEveryAndNotOwner
		).toBe(true)
	})

	it("participantOfEveryAndNotOwner: true for a read-only participant on notes of different owners", () => {
		const notes = [
			note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] }),
			note({ ownerId: SOMEONE_ELSE + 1n, participants: [participant(ME, false)] })
		]

		expect(aggregateNoteSelectionFlags(notes, ME, isUndecryptable).participantOfEveryAndNotOwner).toBe(true)
	})

	it("participantOfEveryAndNotOwner: false if user owns any note", () => {
		const owned = note()
		const participated = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })

		expect(aggregateNoteSelectionFlags([owned, participated], ME, isUndecryptable).participantOfEveryAndNotOwner).toBe(false)
	})

	it("participantOfEveryAndNotOwner: false if user is missing from any participant list", () => {
		const stranger = note({ ownerId: SOMEONE_ELSE, participants: [participant(SOMEONE_ELSE + 1n, true)] })

		expect(aggregateNoteSelectionFlags([stranger], ME, isUndecryptable).participantOfEveryAndNotOwner).toBe(false)
	})

	it("participantOfEveryAndNotOwner: false when user is participant in some but not all notes (mixed)", () => {
		const participated = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })
		const absentFrom = note({ ownerId: SOMEONE_ELSE, participants: [participant(SOMEONE_ELSE + 1n, true)] })

		expect(
			aggregateNoteSelectionFlags([participated, absentFrom], ME, isUndecryptable).participantOfEveryAndNotOwner
		).toBe(false)
	})

	it("combination: mixed favorited / pinned / owned", () => {
		const notes = [
			note({ favorite: true }),
			note({ pinned: true, ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })
		]

		const flags = aggregateNoteSelectionFlags(notes, ME, isUndecryptable)

		expect(flags.count).toBe(2)
		expect(flags.includesFavorited).toBe(true)
		expect(flags.includesPinned).toBe(true)
		expect(flags.everyOwned).toBe(false)
		expect(flags.hasWriteAccessToAll).toBe(false)
	})
})

describe("isNoteOwner", () => {
	it("is true when the given userId matches the note's ownerId", () => {
		expect(isNoteOwner(note({ ownerId: ME }), ME)).toBe(true)
	})

	it("is false when the given userId does not match", () => {
		expect(isNoteOwner(note({ ownerId: SOMEONE_ELSE }), ME)).toBe(false)
	})

	it("is false when userId is undefined (no resolved account yet)", () => {
		expect(isNoteOwner(note({ ownerId: ME }), undefined)).toBe(false)
	})
})

describe("hasNoteWriteAccess", () => {
	it("is true for the owner, with no participant row of their own", () => {
		expect(hasNoteWriteAccess(note({ ownerId: ME }), ME)).toBe(true)
	})

	it("is true for a participant carrying permissionsWrite", () => {
		expect(hasNoteWriteAccess(note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] }), ME)).toBe(true)
	})

	it("is false for a participant without permissionsWrite", () => {
		expect(hasNoteWriteAccess(note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] }), ME)).toBe(false)
	})

	it("is false for a user who is neither owner nor participant, and for an unresolved id", () => {
		const n = note({ ownerId: SOMEONE_ELSE, participants: [participant(SOMEONE_ELSE + 1n, true)] })

		expect(hasNoteWriteAccess(n, ME)).toBe(false)
		expect(hasNoteWriteAccess(n, undefined)).toBe(false)
	})
})
