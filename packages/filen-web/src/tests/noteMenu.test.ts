import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import {
	PencilIcon,
	CopyIcon,
	PinIcon,
	PinOffIcon,
	HeartIcon,
	HeartOffIcon,
	TagIcon,
	FileTypeIcon,
	UsersIcon,
	HistoryIcon,
	ArchiveIcon,
	ArchiveRestoreIcon,
	Trash2Icon,
	LogOutIcon
} from "lucide-react"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"

// noteMenu.logic.ts imports isNoteOwner from lib/actions.ts, which in turn imports the sdk client and
// query client modules — unresolvable/unwanted under node vitest, mirrors itemMenu.test.ts's own mock
// boundary (there: features/drive/lib/download.ts).
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import {
	noteMenuActions,
	noteTagSubmenuEntries,
	tagMenuActions,
	NOTE_TYPE_SUBMENU,
	type NoteActionDescriptor
} from "@/features/notes/components/noteMenu.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "note title",
		preview: "note preview",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: [],
		...overrides
	}
}

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

function ids(note: Note, userId: bigint | undefined): string[] {
	return noteMenuActions(note, userId).map(d => d.id)
}

function facts(note: Note, userId: bigint | undefined): { id: string; labelKey: string; icon: unknown }[] {
	return noteMenuActions(note, userId).map(d => ({ id: d.id, labelKey: d.labelKey, icon: d.icon }))
}

describe("noteMenuActions — owner, normal (not trashed/archived) note", () => {
	it("rename/duplicate/pin/favorite/tags/type/participants/history/archive/trash, in that order", () => {
		expect(ids(mockNote({ ownerId: 1n }), 1n)).toEqual([
			"rename",
			"duplicate",
			"pin",
			"favorite",
			"tags",
			"type",
			"participants",
			"history",
			"archive",
			"trash"
		])
	})
})

describe("noteMenuActions — non-owner (participant), normal note", () => {
	it("omits participants and archive; ends in leave instead of trash", () => {
		expect(ids(mockNote({ ownerId: 1n }), 2n)).toEqual(["rename", "duplicate", "pin", "favorite", "tags", "type", "history", "leave"])
	})

	it("an unresolved current user (undefined) is treated as non-owner", () => {
		expect(ids(mockNote({ ownerId: 1n }), undefined)).not.toContain("archive")
		expect(ids(mockNote({ ownerId: 1n }), undefined)).toContain("leave")
	})
})

describe("noteMenuActions — trashed note", () => {
	it("reduces to exactly restore + deletePermanently, regardless of ownership", () => {
		const trashed = mockNote({ trash: true, ownerId: 1n })

		expect(ids(trashed, 1n)).toEqual(["restore", "deletePermanently"])
		expect(ids(trashed, 2n)).toEqual(["restore", "deletePermanently"])
	})

	it("trash wins over archive when both flags are set", () => {
		const trashedAndArchived = mockNote({ trash: true, archive: true, ownerId: 1n })

		expect(ids(trashedAndArchived, 1n)).toEqual(["restore", "deletePermanently"])
	})
})

describe("noteMenuActions — archived (not trashed) note", () => {
	it("owner: swaps archive for restore, keeps the rest of the owner set", () => {
		expect(ids(mockNote({ archive: true, ownerId: 1n }), 1n)).toEqual([
			"rename",
			"duplicate",
			"pin",
			"favorite",
			"tags",
			"type",
			"participants",
			"history",
			"restore",
			"trash"
		])
	})

	it("non-owner: still offers restore (restoring out of archive is not owner-gated), still ends in leave", () => {
		expect(ids(mockNote({ archive: true, ownerId: 1n }), 2n)).toEqual([
			"rename",
			"duplicate",
			"pin",
			"favorite",
			"tags",
			"type",
			"history",
			"restore",
			"leave"
		])
	})
})

describe("noteMenuActions — pin/favorite label toggle", () => {
	it("labels Pin/Favorite when not yet set", () => {
		const note = mockNote({ pinned: false, favorite: false, ownerId: 1n })
		expect(noteMenuActions(note, 1n).find(d => d.id === "pin")?.labelKey).toBe("noteActionPin")
		expect(noteMenuActions(note, 1n).find(d => d.id === "favorite")?.labelKey).toBe("noteActionFavorite")
	})

	it("labels Unpin/Unfavorite when already set", () => {
		const note = mockNote({ pinned: true, favorite: true, ownerId: 1n })
		expect(noteMenuActions(note, 1n).find(d => d.id === "pin")?.labelKey).toBe("noteActionUnpin")
		expect(noteMenuActions(note, 1n).find(d => d.id === "favorite")?.labelKey).toBe("noteActionUnfavorite")
	})
})

describe("noteMenuActions — run kinds", () => {
	it("rename/deletePermanently/leave dispatch their own dialog kind", () => {
		const owner = mockNote({ ownerId: 1n })
		const trashed = mockNote({ trash: true, ownerId: 1n })
		const shared = mockNote({ ownerId: 1n })

		expect(noteMenuActions(owner, 1n).find(d => d.id === "rename")).toMatchObject({ run: "dialog", dialogKind: "rename" })
		expect(noteMenuActions(trashed, 1n).find(d => d.id === "deletePermanently")).toMatchObject({
			run: "dialog",
			dialogKind: "delete",
			destructive: true
		})
		expect(noteMenuActions(shared, 2n).find(d => d.id === "leave")).toMatchObject({
			run: "dialog",
			dialogKind: "leave",
			destructive: true
		})
	})

	it("tags/type dispatch their own submenu kind", () => {
		const note = mockNote({ ownerId: 1n })

		expect(noteMenuActions(note, 1n).find(d => d.id === "tags")).toMatchObject({ run: "submenu", submenu: "tags" })
		expect(noteMenuActions(note, 1n).find(d => d.id === "type")).toMatchObject({ run: "submenu", submenu: "type" })
	})

	it("pin/favorite/duplicate/archive/restore/trash run directly (no dialog)", () => {
		const note = mockNote({ ownerId: 1n })
		const directIds: NoteActionDescriptor["id"][] = ["pin", "favorite", "duplicate", "archive", "trash"]

		for (const id of directIds) {
			expect(noteMenuActions(note, 1n).find(d => d.id === id)).toMatchObject({ run: "direct" })
		}
	})

	it("participants and history dispatch their own dialog kind", () => {
		const note = mockNote({ ownerId: 1n })

		expect(noteMenuActions(note, 1n).find(d => d.id === "participants")).toMatchObject({
			run: "dialog",
			dialogKind: "participants"
		})
		expect(noteMenuActions(note, 1n).find(d => d.id === "history")).toMatchObject({ run: "dialog", dialogKind: "history" })
	})
})

describe("noteMenuActions — descriptor label/icon facts (NOTE_ACTION_DEFS drift guard)", () => {
	it("owner, normal note: each descriptor carries its expected label and icon", () => {
		expect(facts(mockNote({ ownerId: 1n }), 1n)).toEqual([
			{ id: "rename", labelKey: "noteActionRename", icon: PencilIcon },
			{ id: "duplicate", labelKey: "noteActionDuplicate", icon: CopyIcon },
			{ id: "pin", labelKey: "noteActionPin", icon: PinIcon },
			{ id: "favorite", labelKey: "noteActionFavorite", icon: HeartIcon },
			{ id: "tags", labelKey: "noteActionTags", icon: TagIcon },
			{ id: "type", labelKey: "noteActionType", icon: FileTypeIcon },
			{ id: "participants", labelKey: "noteActionParticipants", icon: UsersIcon },
			{ id: "history", labelKey: "noteActionHistory", icon: HistoryIcon },
			{ id: "archive", labelKey: "noteActionArchive", icon: ArchiveIcon },
			{ id: "trash", labelKey: "noteActionTrash", icon: Trash2Icon }
		])
	})

	it("pinned + favorited: the toggled entries carry the Unpin/Unfavorite label and icon", () => {
		const note = mockNote({ pinned: true, favorite: true, ownerId: 1n })
		expect(facts(note, 1n)).toContainEqual({ id: "pin", labelKey: "noteActionUnpin", icon: PinOffIcon })
		expect(facts(note, 1n)).toContainEqual({ id: "favorite", labelKey: "noteActionUnfavorite", icon: HeartOffIcon })
	})

	it("trashed note: restore/deletePermanently carry their expected label and icon", () => {
		expect(facts(mockNote({ trash: true, ownerId: 1n }), 1n)).toEqual([
			{ id: "restore", labelKey: "noteActionRestore", icon: ArchiveRestoreIcon },
			{ id: "deletePermanently", labelKey: "noteActionDeletePermanently", icon: Trash2Icon }
		])
	})

	it("non-owner: the leave entry carries its expected label and icon", () => {
		expect(facts(mockNote({ ownerId: 1n }), 2n)).toContainEqual({ id: "leave", labelKey: "noteActionLeave", icon: LogOutIcon })
	})
})

describe("noteMenuActions — returns a fresh array each call", () => {
	it("callers may safely treat the result as their own", () => {
		const note = mockNote({ ownerId: 1n })
		const first = noteMenuActions(note, 1n)
		const second = noteMenuActions(note, 1n)

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})

describe("noteTagSubmenuEntries", () => {
	it("checks every tag the note already carries, unchecks the rest", () => {
		const assigned = mockTag({ uuid: testUuid("assigned") })
		const unassigned = mockTag({ uuid: testUuid("unassigned") })
		const note = mockNote({ tags: [assigned] })

		expect(noteTagSubmenuEntries(note, [assigned, unassigned])).toEqual([
			{ tag: assigned, checked: true },
			{ tag: unassigned, checked: false }
		])
	})

	it("returns an empty list when the account has no tags", () => {
		expect(noteTagSubmenuEntries(mockNote(), [])).toEqual([])
	})
})

describe("NOTE_TYPE_SUBMENU", () => {
	it("lists all five note types in the fixed D1 order, each with its own label key", () => {
		expect(NOTE_TYPE_SUBMENU).toEqual([
			{ noteType: "text", labelKey: "noteTypeText" },
			{ noteType: "md", labelKey: "noteTypeMd" },
			{ noteType: "code", labelKey: "noteTypeCode" },
			{ noteType: "rich", labelKey: "noteTypeRich" },
			{ noteType: "checklist", labelKey: "noteTypeChecklist" }
		])
	})
})

describe("tagMenuActions — the tags-view row menu", () => {
	it("lists rename, favorite, delete in that order for an unfavorited tag", () => {
		expect(tagMenuActions(mockTag()).map(d => ({ id: d.id, labelKey: d.labelKey, run: d.run }))).toEqual([
			{ id: "tagRename", labelKey: "noteTagActionRename", run: "dialog" },
			{ id: "tagFavorite", labelKey: "noteTagActionFavorite", run: "direct" },
			{ id: "tagDelete", labelKey: "noteTagActionDelete", run: "dialog" }
		])
	})

	it("flips the favorite entry's label for an already-favorited tag, keeping order stable", () => {
		const descriptors = tagMenuActions(mockTag({ favorite: true }))

		expect(descriptors.map(d => d.id)).toEqual(["tagRename", "tagFavorite", "tagDelete"])
		expect(descriptors[1]?.labelKey).toBe("noteTagActionUnfavorite")
	})

	it("routes rename and delete to their disjoint tag dialog kinds, delete destructive", () => {
		const descriptors = tagMenuActions(mockTag())
		const rename = descriptors[0]
		const del = descriptors[2]

		expect(rename?.run === "dialog" && rename.dialogKind).toBe("renameTag")
		expect(del?.run === "dialog" && del.dialogKind).toBe("deleteTag")
		expect(del?.run === "dialog" && del.destructive).toBe(true)
	})
})
