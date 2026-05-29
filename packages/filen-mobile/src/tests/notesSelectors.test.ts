import { describe, it, expect } from "vitest"
import {
	aggregateNoteSelectionFlags,
	aggregateNoteTagSelectionFlags,
	EMPTY_NOTE_FLAGS,
	EMPTY_NOTE_TAG_FLAGS
} from "@/lib/notesSelectors"
import { type Note, type NoteTag, type NoteParticipant } from "@/types"

const ME = 100n
const SOMEONE_ELSE = 200n

function participant(userId: bigint, permissionsWrite: boolean): NoteParticipant {
	return { userId, permissionsWrite } as NoteParticipant
}

function note(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "u",
		ownerId: ME,
		favorite: false,
		pinned: false,
		trash: false,
		archive: false,
		undecryptable: false,
		participants: [],
		tags: [],
		...overrides
	} as Note
}

describe("aggregateNoteSelectionFlags", () => {
	it("returns EMPTY_NOTE_FLAGS when selection is empty", () => {
		expect(aggregateNoteSelectionFlags([], ME)).toBe(EMPTY_NOTE_FLAGS)
	})

	it("returns EMPTY_NOTE_FLAGS when userId is undefined", () => {
		expect(aggregateNoteSelectionFlags([note()], undefined)).toBe(EMPTY_NOTE_FLAGS)
	})

	it("EMPTY_NOTE_FLAGS is frozen", () => {
		expect(Object.isFrozen(EMPTY_NOTE_FLAGS)).toBe(true)
	})

	it("counts selected notes", () => {
		const flags = aggregateNoteSelectionFlags([note(), note(), note()], ME)

		expect(flags.count).toBe(3)
	})

	it("includesFavorited true when any note is favorited", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ favorite: true })], ME).includesFavorited).toBe(true)
	})

	it("includesFavorited false when no note is favorited", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME).includesFavorited).toBe(false)
	})

	it("includesPinned mirrors any-pinned", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ pinned: true })], ME).includesPinned).toBe(true)
		expect(aggregateNoteSelectionFlags([note(), note()], ME).includesPinned).toBe(false)
	})

	it("includesTrashed mirrors any-trashed", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ trash: true })], ME).includesTrashed).toBe(true)
	})

	it("includesArchived true when any note is archived", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ archive: true })], ME).includesArchived).toBe(true)
	})

	it("includesArchived false when no note is archived", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME).includesArchived).toBe(false)
	})

	it("includesUndecryptable true when any note is undecryptable", () => {
		expect(aggregateNoteSelectionFlags([note(), note({ undecryptable: true })], ME).includesUndecryptable).toBe(true)
	})

	it("includesUndecryptable false when no note is undecryptable", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME).includesUndecryptable).toBe(false)
	})

	it("everyOwned true only when current user owns every note", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME).everyOwned).toBe(true)
		expect(aggregateNoteSelectionFlags([note(), note({ ownerId: SOMEONE_ELSE })], ME).everyOwned).toBe(false)
	})

	it("everyArchived true only when every note is archived", () => {
		expect(aggregateNoteSelectionFlags([note({ archive: true }), note({ archive: true })], ME).everyArchived).toBe(true)
		expect(aggregateNoteSelectionFlags([note({ archive: true }), note()], ME).everyArchived).toBe(false)
	})

	it("everyTrashed true only when every note is trashed", () => {
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note({ trash: true })], ME).everyTrashed).toBe(true)
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note()], ME).everyTrashed).toBe(false)
	})

	it("everyArchivedOrTrashed true when every note is archived or trashed", () => {
		expect(aggregateNoteSelectionFlags([note({ archive: true }), note({ archive: true })], ME).everyArchivedOrTrashed).toBe(true)
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note({ trash: true })], ME).everyArchivedOrTrashed).toBe(true)
		expect(aggregateNoteSelectionFlags([note({ archive: true }), note({ trash: true })], ME).everyArchivedOrTrashed).toBe(true)
	})

	it("everyArchivedOrTrashed false when any note is active", () => {
		expect(aggregateNoteSelectionFlags([note({ archive: true }), note()], ME).everyArchivedOrTrashed).toBe(false)
		expect(aggregateNoteSelectionFlags([note({ trash: true }), note()], ME).everyArchivedOrTrashed).toBe(false)
	})

	it("hasWriteAccessToAll: owner of all has write", () => {
		expect(aggregateNoteSelectionFlags([note(), note()], ME).hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll: participant with write counts as write", () => {
		const shared = note({
			ownerId: SOMEONE_ELSE,
			participants: [participant(ME, true)]
		})

		expect(aggregateNoteSelectionFlags([shared], ME).hasWriteAccessToAll).toBe(true)
	})

	it("hasWriteAccessToAll: participant read-only does not count as write", () => {
		const shared = note({
			ownerId: SOMEONE_ELSE,
			participants: [participant(ME, false)]
		})

		expect(aggregateNoteSelectionFlags([shared], ME).hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll: mixed write + read-only is false", () => {
		const writeable = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, true)] })
		const readOnly = note({ ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })

		expect(aggregateNoteSelectionFlags([writeable, readOnly], ME).hasWriteAccessToAll).toBe(false)
	})

	it("hasWriteAccessToAll: false when user is not a participant and not the owner", () => {
		const stranger = note({
			ownerId: SOMEONE_ELSE,
			participants: [participant(SOMEONE_ELSE + 1n, true)]
		})

		expect(aggregateNoteSelectionFlags([stranger], ME).hasWriteAccessToAll).toBe(false)
	})

	it("participantOfEveryAndNotOwner: true only if user is participant + not owner of ALL", () => {
		const participated = note({
			ownerId: SOMEONE_ELSE,
			participants: [participant(ME, true)]
		})

		expect(aggregateNoteSelectionFlags([participated, participated], ME).participantOfEveryAndNotOwner).toBe(true)
	})

	it("participantOfEveryAndNotOwner: false if user owns any note", () => {
		const owned = note()
		const participated = note({
			ownerId: SOMEONE_ELSE,
			participants: [participant(ME, true)]
		})

		expect(aggregateNoteSelectionFlags([owned, participated], ME).participantOfEveryAndNotOwner).toBe(false)
	})

	it("participantOfEveryAndNotOwner: false if user is missing from any participant list", () => {
		const stranger = note({
			ownerId: SOMEONE_ELSE,
			participants: [participant(SOMEONE_ELSE + 1n, true)]
		})

		expect(aggregateNoteSelectionFlags([stranger], ME).participantOfEveryAndNotOwner).toBe(false)
	})

	it("combination: mixed favorited / pinned / owned", () => {
		const notes = [
			note({ favorite: true }),
			note({ pinned: true, ownerId: SOMEONE_ELSE, participants: [participant(ME, false)] })
		]

		const flags = aggregateNoteSelectionFlags(notes, ME)

		expect(flags.count).toBe(2)
		expect(flags.includesFavorited).toBe(true)
		expect(flags.includesPinned).toBe(true)
		expect(flags.everyOwned).toBe(false)
		expect(flags.hasWriteAccessToAll).toBe(false)
	})
})

function tag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: "t",
		name: "tag",
		favorite: false,
		undecryptable: false,
		...overrides
	} as NoteTag
}

describe("aggregateNoteTagSelectionFlags", () => {
	it("returns EMPTY_NOTE_TAG_FLAGS on empty selection", () => {
		expect(aggregateNoteTagSelectionFlags([])).toBe(EMPTY_NOTE_TAG_FLAGS)
	})

	it("EMPTY_NOTE_TAG_FLAGS is frozen", () => {
		expect(Object.isFrozen(EMPTY_NOTE_TAG_FLAGS)).toBe(true)
	})

	it("counts tags and detects any-favorited", () => {
		expect(aggregateNoteTagSelectionFlags([tag(), tag({ favorite: true })])).toEqual({
			count: 2,
			includesFavorited: true
		})
	})

	it("includesFavorited false when none favorited", () => {
		expect(aggregateNoteTagSelectionFlags([tag(), tag()]).includesFavorited).toBe(false)
	})
})
