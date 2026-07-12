import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import {
	PinIcon,
	PinOffIcon,
	HeartIcon,
	HeartOffIcon,
	FileTypeIcon,
	TagIcon,
	CopyIcon,
	DownloadIcon,
	ArchiveIcon,
	ArchiveRestoreIcon,
	Trash2Icon,
	LogOutIcon
} from "lucide-react"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"

// notesBulkActionBar.logic.ts's own imports are all pure/type-only, but resolving its module path
// still resolves selectionFlags.ts's — mirrors noteMenu.test.ts's own mock boundary (isNoteOwner's
// sdk/queryClient chain, unresolvable/unwanted under node vitest).
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { noteBulkActions, noteBulkTagSubmenuEntries } from "@/features/notes/components/notesBulkActionBar.logic"
import { type NoteSelectionFlags } from "@/features/notes/lib/selectionFlags"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function flags(overrides: Partial<NoteSelectionFlags> = {}): NoteSelectionFlags {
	return {
		count: 2,
		includesFavorited: false,
		includesPinned: false,
		includesArchived: false,
		includesTrashed: false,
		includesUndecryptable: false,
		everyOwned: false,
		everyTrashed: false,
		everyArchivedOrTrashed: false,
		hasWriteAccessToAll: false,
		participantOfEveryAndNotOwner: false,
		...overrides
	}
}

function ids(descriptors: ReturnType<typeof noteBulkActions>): string[] {
	return descriptors.map(d => d.id)
}

describe("noteBulkActions — undecryptable gate", () => {
	it("suppresses every metadata-needing action (pin/favorite/type/tags/duplicate/export) when the selection includes an undecryptable note", () => {
		const descriptors = noteBulkActions(flags({ includesUndecryptable: true, everyOwned: true, hasWriteAccessToAll: true }))

		expect(ids(descriptors)).not.toEqual(expect.arrayContaining(["pin", "favorite", "type", "tags", "duplicate", "export"]))
	})

	it("still offers pin/favorite/type/tags/duplicate/export when nothing is undecryptable and write access is granted", () => {
		const descriptors = noteBulkActions(flags({ includesUndecryptable: false, hasWriteAccessToAll: true }))

		expect(ids(descriptors)).toEqual(["pin", "favorite", "type", "tags", "duplicate", "export"])
	})

	it("drops the type entry alone when write access is missing, keeping every other metadata action", () => {
		const descriptors = noteBulkActions(flags({ includesUndecryptable: false, hasWriteAccessToAll: false }))

		expect(ids(descriptors)).toEqual(["pin", "favorite", "tags", "duplicate", "export"])
	})
})

describe("noteBulkActions — pin/favorite SET-semantics labels", () => {
	it("labels Pin/Favorite (not Unpin/Unfavorite) when nothing in the selection is pinned/favorited", () => {
		const [pin, favorite] = noteBulkActions(flags({ includesPinned: false, includesFavorited: false }))

		expect(pin).toMatchObject({ id: "pin", labelKey: "noteActionPin", icon: PinIcon, run: "direct" })
		expect(favorite).toMatchObject({ id: "favorite", labelKey: "noteActionFavorite", icon: HeartIcon, run: "direct" })
	})

	it("labels Unpin/Unfavorite when ANY selected note is already pinned/favorited", () => {
		const [pin, favorite] = noteBulkActions(flags({ includesPinned: true, includesFavorited: true }))

		expect(pin).toMatchObject({ labelKey: "noteActionUnpin", icon: PinOffIcon })
		expect(favorite).toMatchObject({ labelKey: "noteActionUnfavorite", icon: HeartOffIcon })
	})
})

describe("noteBulkActions — type/tags submenu shape", () => {
	it("type is a submenu descriptor gated on hasWriteAccessToAll", () => {
		const type = noteBulkActions(flags({ hasWriteAccessToAll: true })).find(d => d.id === "type")

		expect(type).toMatchObject({ run: "submenu", submenu: "type", icon: FileTypeIcon })
	})

	it("tags is always a submenu descriptor once nothing is undecryptable, regardless of write access", () => {
		const tags = noteBulkActions(flags({ hasWriteAccessToAll: false })).find(d => d.id === "tags")

		expect(tags).toMatchObject({ run: "submenu", submenu: "tags", icon: TagIcon })
	})
})

describe("noteBulkActions — duplicate/export descriptor shape", () => {
	it("duplicate and export are direct actions with their expected icons", () => {
		const descriptors = noteBulkActions(flags())
		const duplicate = descriptors.find(d => d.id === "duplicate")
		const exportAction = descriptors.find(d => d.id === "export")

		expect(duplicate).toMatchObject({ run: "direct", icon: CopyIcon })
		expect(exportAction).toMatchObject({ run: "direct", icon: DownloadIcon })
	})
})

describe("noteBulkActions — owner-gated lifecycle (archive/restore/trash/delete)", () => {
	it("offers nothing lifecycle-related when the current user does not own every selected note", () => {
		const descriptors = noteBulkActions(flags({ everyOwned: false }))

		expect(ids(descriptors)).not.toEqual(expect.arrayContaining(["archive", "restore", "trash", "delete"]))
	})

	it("archive requires everyOwned, none archived, none trashed, none undecryptable", () => {
		const eligible = noteBulkActions(
			flags({ everyOwned: true, includesArchived: false, includesTrashed: false, includesUndecryptable: false })
		)
		const archivedInMix = noteBulkActions(flags({ everyOwned: true, includesArchived: true }))
		const trashedInMix = noteBulkActions(flags({ everyOwned: true, includesTrashed: true }))

		expect(ids(eligible)).toContain("archive")
		expect(ids(archivedInMix)).not.toContain("archive")
		expect(ids(trashedInMix)).not.toContain("archive")
	})

	it("restore requires everyArchivedOrTrashed; suppressed for a mixed-undecryptable selection unless everyTrashed", () => {
		const eligible = noteBulkActions(flags({ everyOwned: true, everyArchivedOrTrashed: true }))
		const activeInMix = noteBulkActions(flags({ everyOwned: true, everyArchivedOrTrashed: false }))
		const undecryptableNotTrashed = noteBulkActions(
			flags({ everyOwned: true, everyArchivedOrTrashed: true, includesUndecryptable: true, everyTrashed: false })
		)
		const undecryptableAllTrashed = noteBulkActions(
			flags({ everyOwned: true, everyArchivedOrTrashed: true, includesUndecryptable: true, everyTrashed: true })
		)

		expect(ids(eligible)).toContain("restore")
		expect(ids(activeInMix)).not.toContain("restore")
		expect(ids(undecryptableNotTrashed)).not.toContain("restore")
		expect(ids(undecryptableAllTrashed)).toContain("restore")
	})

	it("trash requires everyOwned and none already trashed — survives includesUndecryptable (pure-uuid disposition)", () => {
		const eligible = noteBulkActions(flags({ everyOwned: true, includesTrashed: false }))
		const alreadyTrashed = noteBulkActions(flags({ everyOwned: true, includesTrashed: true }))
		const undecryptableEligible = noteBulkActions(flags({ everyOwned: true, includesTrashed: false, includesUndecryptable: true }))

		expect(ids(eligible)).toContain("trash")
		expect(ids(alreadyTrashed)).not.toContain("trash")
		expect(ids(undecryptableEligible)).toContain("trash")
	})

	it("trash dispatches the trashSelected dialog kind and is never destructive-styled (recoverable)", () => {
		const trash = noteBulkActions(flags({ everyOwned: true })).find(d => d.id === "trash")

		expect(trash).toMatchObject({ run: "dialog", dialogKind: "trashSelected", icon: Trash2Icon })
		expect(trash?.destructive).toBeFalsy()
	})

	it("delete requires everyOwned and everyTrashed, dispatches deleteSelected, destructive-styled", () => {
		const eligible = noteBulkActions(flags({ everyOwned: true, everyTrashed: true })).find(d => d.id === "delete")
		const notAllTrashed = noteBulkActions(flags({ everyOwned: true, everyTrashed: false }))

		expect(eligible).toMatchObject({ run: "dialog", dialogKind: "deleteSelected", destructive: true, icon: Trash2Icon })
		expect(ids(notAllTrashed)).not.toContain("delete")
	})
})

describe("noteBulkActions — leave (non-owner participant gate)", () => {
	it("appears only when participantOfEveryAndNotOwner is true, dispatches leaveSelected, destructive-styled", () => {
		const eligible = noteBulkActions(flags({ participantOfEveryAndNotOwner: true })).find(d => d.id === "leave")
		const absent = noteBulkActions(flags({ participantOfEveryAndNotOwner: false }))

		expect(eligible).toMatchObject({ run: "dialog", dialogKind: "leaveSelected", destructive: true, icon: LogOutIcon })
		expect(ids(absent)).not.toContain("leave")
	})

	it("can coexist with lifecycle actions being absent — leave is independent of everyOwned", () => {
		const descriptors = noteBulkActions(flags({ everyOwned: false, participantOfEveryAndNotOwner: true }))

		expect(ids(descriptors)).toEqual(["pin", "favorite", "tags", "duplicate", "export", "leave"])
	})
})

describe("noteBulkActions — archive/restore icon identity", () => {
	it("archive and restore carry their expected icons", () => {
		const archive = noteBulkActions(flags({ everyOwned: true })).find(d => d.id === "archive")
		const restore = noteBulkActions(flags({ everyOwned: true, everyArchivedOrTrashed: true })).find(d => d.id === "restore")

		expect(archive).toMatchObject({ icon: ArchiveIcon })
		expect(restore).toMatchObject({ icon: ArchiveRestoreIcon })
	})
})

function mockTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: testUuid("tag"),
		name: "tag",
		favorite: false,
		editedTimestamp: 1_700_000_000_000n,
		createdTimestamp: 1_700_000_000_000n,
		...overrides
	}
}

function mockNote(tags: NoteTag[], uuid: UuidStr = testUuid("note")): Note {
	return {
		uuid,
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags,
		noteType: "text",
		encryptionKey: "key",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: []
	}
}

describe("noteBulkTagSubmenuEntries — tri-state collapse", () => {
	it("checks a tag only when EVERY selected note already carries it", () => {
		const shared = mockTag({ uuid: testUuid("shared") })
		const partial = mockTag({ uuid: testUuid("partial") })
		const noteA = mockNote([shared, partial], testUuid("a"))
		const noteB = mockNote([shared], testUuid("b"))

		const entries = noteBulkTagSubmenuEntries([noteA, noteB], [shared, partial])

		expect(entries).toEqual([
			{ tag: shared, checked: true },
			{ tag: partial, checked: false }
		])
	})

	it("checks no tag at all when the selection is empty", () => {
		const tag = mockTag()

		expect(noteBulkTagSubmenuEntries([], [tag])).toEqual([{ tag, checked: false }])
	})

	it("returns one entry per account tag, in the given order", () => {
		const tagA = mockTag({ uuid: testUuid("a") })
		const tagB = mockTag({ uuid: testUuid("b") })
		const note = mockNote([tagA, tagB])

		expect(noteBulkTagSubmenuEntries([note], [tagA, tagB]).map(e => e.tag.uuid)).toEqual([tagA.uuid, tagB.uuid])
	})
})
