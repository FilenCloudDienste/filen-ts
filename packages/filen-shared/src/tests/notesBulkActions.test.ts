import { describe, it, expect } from "vitest"
import { noteBulkActionAvailability, type NoteBulkFlagsCore } from "@filen/shared"

function flags(overrides: Partial<NoteBulkFlagsCore> = {}): NoteBulkFlagsCore {
	return {
		count: 2,
		includesUndecryptable: false,
		includesArchived: false,
		includesTrashed: false,
		everyOwned: false,
		everyArchivedOrTrashed: false,
		everyTrashed: false,
		hasWriteAccessToAll: false,
		participantOfEveryAndNotOwner: false,
		...overrides
	}
}

describe("noteBulkActionAvailability — count guard", () => {
	it("disables everything for an empty selection, regardless of the other flags", () => {
		const availability = noteBulkActionAvailability(
			flags({ count: 0, everyOwned: true, hasWriteAccessToAll: true, participantOfEveryAndNotOwner: true })
		)

		expect(availability).toEqual({
			pin: false,
			favorite: false,
			type: false,
			tags: false,
			duplicate: false,
			export: false,
			archive: false,
			restore: false,
			trash: false,
			delete: false,
			leave: false
		})
	})
})

describe("noteBulkActionAvailability — undecryptable gate", () => {
	it("suppresses pin/favorite/type/tags/duplicate/export when the selection includes an undecryptable note", () => {
		const availability = noteBulkActionAvailability(
			flags({ includesUndecryptable: true, everyOwned: true, hasWriteAccessToAll: true })
		)

		expect(availability.pin).toBe(false)
		expect(availability.favorite).toBe(false)
		expect(availability.type).toBe(false)
		expect(availability.tags).toBe(false)
		expect(availability.duplicate).toBe(false)
		expect(availability.export).toBe(false)
	})

	it("offers pin/favorite/tags/duplicate/export once nothing is undecryptable, type only with write access", () => {
		const withWrite = noteBulkActionAvailability(flags({ hasWriteAccessToAll: true }))
		const withoutWrite = noteBulkActionAvailability(flags({ hasWriteAccessToAll: false }))

		expect(withWrite.pin).toBe(true)
		expect(withWrite.favorite).toBe(true)
		expect(withWrite.type).toBe(true)
		expect(withWrite.tags).toBe(true)
		expect(withWrite.duplicate).toBe(true)
		expect(withWrite.export).toBe(true)
		expect(withoutWrite.type).toBe(false)
	})
})

describe("noteBulkActionAvailability — owner-gated lifecycle (archive/restore/trash/delete)", () => {
	it("offers nothing lifecycle-related when the current user does not own every selected note", () => {
		const availability = noteBulkActionAvailability(flags({ everyOwned: false }))

		expect(availability.archive).toBe(false)
		expect(availability.restore).toBe(false)
		expect(availability.trash).toBe(false)
		expect(availability.delete).toBe(false)
	})

	it("archive requires everyOwned, none archived, none trashed, none undecryptable", () => {
		expect(
			noteBulkActionAvailability(
				flags({ everyOwned: true, includesArchived: false, includesTrashed: false, includesUndecryptable: false })
			).archive
		).toBe(true)
		expect(noteBulkActionAvailability(flags({ everyOwned: true, includesArchived: true })).archive).toBe(false)
		expect(noteBulkActionAvailability(flags({ everyOwned: true, includesTrashed: true })).archive).toBe(false)
		expect(noteBulkActionAvailability(flags({ everyOwned: true, includesUndecryptable: true })).archive).toBe(false)
	})

	it("restore requires everyArchivedOrTrashed; suppressed for a mixed-undecryptable selection unless everyTrashed", () => {
		expect(noteBulkActionAvailability(flags({ everyOwned: true, everyArchivedOrTrashed: true })).restore).toBe(true)
		expect(noteBulkActionAvailability(flags({ everyOwned: true, everyArchivedOrTrashed: false })).restore).toBe(false)
		expect(
			noteBulkActionAvailability(
				flags({ everyOwned: true, everyArchivedOrTrashed: true, includesUndecryptable: true, everyTrashed: false })
			).restore
		).toBe(false)
		expect(
			noteBulkActionAvailability(
				flags({ everyOwned: true, everyArchivedOrTrashed: true, includesUndecryptable: true, everyTrashed: true })
			).restore
		).toBe(true)
	})

	it("trash requires everyOwned and none already trashed — survives includesUndecryptable (pure-uuid disposition)", () => {
		expect(noteBulkActionAvailability(flags({ everyOwned: true, includesTrashed: false })).trash).toBe(true)
		expect(noteBulkActionAvailability(flags({ everyOwned: true, includesTrashed: true })).trash).toBe(false)
		expect(
			noteBulkActionAvailability(flags({ everyOwned: true, includesTrashed: false, includesUndecryptable: true })).trash
		).toBe(true)
	})

	it("delete requires everyOwned and everyTrashed", () => {
		expect(noteBulkActionAvailability(flags({ everyOwned: true, everyTrashed: true })).delete).toBe(true)
		expect(noteBulkActionAvailability(flags({ everyOwned: true, everyTrashed: false })).delete).toBe(false)
	})
})

describe("noteBulkActionAvailability — leave (non-owner participant gate)", () => {
	it("is available only when participantOfEveryAndNotOwner is true, independent of everyOwned", () => {
		expect(noteBulkActionAvailability(flags({ participantOfEveryAndNotOwner: true })).leave).toBe(true)
		expect(noteBulkActionAvailability(flags({ participantOfEveryAndNotOwner: false })).leave).toBe(false)
		expect(
			noteBulkActionAvailability(flags({ everyOwned: false, participantOfEveryAndNotOwner: true })).leave
		).toBe(true)
	})
})
