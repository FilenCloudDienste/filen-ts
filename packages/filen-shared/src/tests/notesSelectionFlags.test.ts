import { describe, it, expect } from "vitest"
import { aggregateNoteSelectionFlags } from "@filen/shared"

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

describe("aggregateNoteSelectionFlags — empty/degenerate input", () => {
	it("returns the empty-flags shape for an empty selection", () => {
		expect(aggregateNoteSelectionFlags([], ME, isUndecryptable)).toMatchObject({ count: 0, everyOwned: false })
	})

	it("returns the empty-flags shape when currentUserId is unresolved", () => {
		expect(aggregateNoteSelectionFlags([note()], undefined, isUndecryptable)).toMatchObject({ count: 0, everyOwned: false })
	})
})

describe("aggregateNoteSelectionFlags — includes* flags (any-of)", () => {
	it("includesFavorited/includesPinned/includesArchived/includesTrashed are true when ANY selected note has the flag", () => {
		const flags = aggregateNoteSelectionFlags(
			[note(), note({ favorite: true, pinned: true, archive: true })],
			ME,
			isUndecryptable
		)

		expect(flags).toMatchObject({ includesFavorited: true, includesPinned: true, includesArchived: true })
	})

	it("includesUndecryptable is true when any selected note's metadata never decrypted", () => {
		const flags = aggregateNoteSelectionFlags([note(), note({ undecryptable: true })], ME, isUndecryptable)

		expect(flags.includesUndecryptable).toBe(true)
	})

	it("every include* flag is false when nothing in the selection has it", () => {
		const flags = aggregateNoteSelectionFlags([note(), note()], ME, isUndecryptable)

		expect(flags).toMatchObject({
			includesFavorited: false,
			includesPinned: false,
			includesArchived: false,
			includesTrashed: false,
			includesUndecryptable: false
		})
	})
})

describe("aggregateNoteSelectionFlags — everyOwned / hasWriteAccessToAll", () => {
	it("everyOwned is true only when the current user owns every selected note", () => {
		const allOwned = aggregateNoteSelectionFlags([note({ ownerId: ME }), note({ ownerId: ME })], ME, isUndecryptable)
		const mixed = aggregateNoteSelectionFlags([note({ ownerId: ME }), note({ ownerId: SOMEONE_ELSE })], ME, isUndecryptable)

		expect(allOwned.everyOwned).toBe(true)
		expect(mixed.everyOwned).toBe(false)
	})

	it("hasWriteAccessToAll is true for the owner regardless of a participants list", () => {
		const flags = aggregateNoteSelectionFlags([note({ ownerId: ME, participants: [] })], ME, isUndecryptable)

		expect(flags.hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll is true for a write-permitted participant on every selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })],
			ME,
			isUndecryptable
		)

		expect(flags.hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll is false when any selected note has the user as a read-only participant", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] }),
				note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })
			],
			ME,
			isUndecryptable
		)

		expect(flags.hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll is false when the current user isn't a participant on a selected note at all", () => {
		const flags = aggregateNoteSelectionFlags([note({ ownerId: SOMEONE_ELSE, participants: [] })], ME, isUndecryptable)

		expect(flags.hasWriteAccessToAll).toBe(false)
	})
})

describe("aggregateNoteSelectionFlags — lifecycle gates (everyTrashed / everyArchivedOrTrashed)", () => {
	it("everyTrashed is true only when every selected note is trashed", () => {
		const allTrashed = aggregateNoteSelectionFlags([note({ trash: true }), note({ trash: true })], ME, isUndecryptable)
		const mixed = aggregateNoteSelectionFlags([note({ trash: true }), note({ trash: false })], ME, isUndecryptable)

		expect(allTrashed.everyTrashed).toBe(true)
		expect(mixed.everyTrashed).toBe(false)
	})

	it("everyArchivedOrTrashed is true when every note is archived, trashed, or both — false if any is active", () => {
		const nonActive = aggregateNoteSelectionFlags([note({ archive: true }), note({ trash: true })], ME, isUndecryptable)
		const withActive = aggregateNoteSelectionFlags([note({ archive: true }), note()], ME, isUndecryptable)

		expect(nonActive.everyArchivedOrTrashed).toBe(true)
		expect(withActive.everyArchivedOrTrashed).toBe(false)
	})
})

describe("aggregateNoteSelectionFlags — participantOfEveryAndNotOwner (Leave gate)", () => {
	it("is true when the current user is a participant (not owner) on every selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] }),
				note({ ownerId: SOMEONE_ELSE + 1n, participants: [participant(ME, false)] })
			],
			ME,
			isUndecryptable
		)

		expect(flags.participantOfEveryAndNotOwner).toBe(true)
	})

	it("is false when the current user owns any selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[note({ ownerId: ME }), note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })],
			ME,
			isUndecryptable
		)

		expect(flags.participantOfEveryAndNotOwner).toBe(false)
	})

	it("is false when the current user isn't a participant on some selected note", () => {
		const flags = aggregateNoteSelectionFlags(
			[
				note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] }),
				note({ ownerId: SOMEONE_ELSE + 1n, participants: [] })
			],
			ME,
			isUndecryptable
		)

		expect(flags.participantOfEveryAndNotOwner).toBe(false)
	})
})
