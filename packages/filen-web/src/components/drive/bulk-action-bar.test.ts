import { describe, expect, it } from "vitest"
import { StarIcon, StarOffIcon, FolderInputIcon, UserMinusIcon, Trash2Icon, RotateCcwIcon } from "lucide-react"
import { type DriveSelectionFlags } from "@/lib/drive/selection-flags"
import { driveBulkActions } from "@/components/drive/bulk-action-bar.logic"

function flags(overrides: Partial<DriveSelectionFlags> = {}): DriveSelectionFlags {
	return {
		count: 2,
		includesFavorited: false,
		everyFile: false,
		everyDirectory: false,
		includesUndecryptable: false,
		everySharedRoot: false,
		...overrides
	}
}

describe("driveBulkActions", () => {
	it("trash variant: exactly restoreSelected then delete, regardless of flags — no favorite/move surface in trash", () => {
		const descriptors = driveBulkActions("trash", flags({ includesUndecryptable: true, includesFavorited: true }))

		expect(descriptors.map(d => d.id)).toEqual(["restoreSelected", "delete"])
	})

	it("trash variant: restoreSelected opens the bulk-restore confirm dialog, not a direct restore", () => {
		const [restoreSelected] = driveBulkActions("trash", flags())

		expect(restoreSelected).toMatchObject({ run: "dialog", dialogKind: "restoreSelected", icon: RotateCcwIcon })
	})

	it("trash variant: delete is destructive-styled and dialog-routed to the delete confirm", () => {
		const [, deletePermanently] = driveBulkActions("trash", flags())

		expect(deletePermanently).toMatchObject({ run: "dialog", dialogKind: "delete", destructive: true, icon: Trash2Icon })
	})

	it.each(["drive", "recents", "favorites"] as const)(
		"%s variant, decryptable selection, none favorited: favorite, move, share, trash in that order",
		variant => {
			const descriptors = driveBulkActions(variant, flags({ includesFavorited: false, includesUndecryptable: false }))

			expect(descriptors.map(d => d.id)).toEqual(["favorite", "move", "share", "trash"])
		}
	)

	// Bulk share gates like single-item share: the owned surfaces only (drive/recents/favorites/
	// sharedOut), never shared-with-me, and never when the selection includes an undecryptable item.
	it("share is present on sharedOut bulk but absent on sharedIn bulk (owned surfaces only)", () => {
		expect(driveBulkActions("sharedOut", flags({ includesUndecryptable: false })).map(d => d.id)).toContain("share")
		expect(driveBulkActions("sharedIn", flags({ includesUndecryptable: false })).map(d => d.id)).not.toContain("share")
	})

	it("bulk share is suppressed when the selection includes an undecryptable item", () => {
		expect(driveBulkActions("drive", flags({ includesUndecryptable: true })).map(d => d.id)).not.toContain("share")
	})

	it("bulk share opens the contact-picker dialog kind", () => {
		const share = driveBulkActions("drive", flags({ includesUndecryptable: false })).find(d => d.id === "share")

		expect(share).toMatchObject({ run: "dialog", dialogKind: "share" })
	})

	it("favorite descriptor labels/icons Favorite when nothing in the selection is favorited", () => {
		const [favorite] = driveBulkActions("drive", flags({ includesFavorited: false, includesUndecryptable: false }))

		expect(favorite).toMatchObject({ run: "direct", labelKey: "driveActionFavorite", icon: StarIcon })
	})

	it("favorite descriptor labels/icons Unfavorite when ANY item in the selection is favorited (SET semantics)", () => {
		const [favorite] = driveBulkActions("drive", flags({ includesFavorited: true, includesUndecryptable: false }))

		expect(favorite).toMatchObject({ run: "direct", labelKey: "driveActionUnfavorite", icon: StarOffIcon })
	})

	it("move descriptor opens the move dialog", () => {
		const descriptors = driveBulkActions("drive", flags({ includesUndecryptable: false }))
		const move = descriptors.find(d => d.id === "move")

		expect(move).toMatchObject({ run: "dialog", dialogKind: "move", icon: FolderInputIcon })
	})

	it.each(["drive", "recents", "favorites"] as const)(
		"%s variant, any undecryptable item: favorite and move are suppressed, trash alone remains",
		variant => {
			const descriptors = driveBulkActions(variant, flags({ includesUndecryptable: true }))

			expect(descriptors.map(d => d.id)).toEqual(["trash"])
		}
	)

	it("trash descriptor is never destructive-styled (recoverable, matches the per-item TRASH descriptor)", () => {
		const descriptors = driveBulkActions("drive", flags({ includesUndecryptable: false }))
		const trash = descriptors.find(d => d.id === "trash")

		expect(trash).toMatchObject({ run: "dialog", dialogKind: "trash", icon: Trash2Icon })
		expect(trash?.destructive).toBeFalsy()
	})

	it("trash action is present even when the selection includes an undecryptable item — pure-uuid dispositions stay available", () => {
		const descriptors = driveBulkActions("drive", flags({ includesUndecryptable: true }))

		expect(descriptors.some(d => d.id === "trash")).toBe(true)
	})

	// No bulk color action exists (mobile parity — everyDirectory is aggregated but never consumed for
	// bulk; color stays single-item in the per-row menu). Proven by construction rather than a runtime
	// assertion: BulkActionId has no "color" member, so driveBulkActions can never return one — every
	// exhaustive id list asserted above (favorite/move/trash, trash-only, restoreSelected/delete) is
	// the complete set the return type allows.
	it("an everyDirectory-true selection is not itself a gate — it changes nothing about which actions render", () => {
		const withDirs = driveBulkActions("drive", flags({ includesUndecryptable: false, everyDirectory: true }))
		const withoutDirs = driveBulkActions("drive", flags({ includesUndecryptable: false, everyDirectory: false }))

		expect(withDirs.map(d => d.id)).toEqual(withoutDirs.map(d => d.id))
	})
})

// Unshare (removeSharedItem) is root-only — gated purely on everySharedRoot (the WHOLE selection is
// sharedRootDirectory/sharedRootFile arms), mirroring item-menu.logic.ts's own per-item type gate.
describe("driveBulkActions — unshare gating (everySharedRoot)", () => {
	it("appears when the whole selection is shared-root arms, on both sharedOut and sharedIn", () => {
		expect(driveBulkActions("sharedOut", flags({ everySharedRoot: true })).map(d => d.id)).toContain("unshare")
		expect(driveBulkActions("sharedIn", flags({ everySharedRoot: true })).map(d => d.id)).toContain("unshare")
	})

	it("is absent when the selection is not entirely shared-root arms", () => {
		expect(driveBulkActions("drive", flags({ everySharedRoot: false })).map(d => d.id)).not.toContain("unshare")
		expect(driveBulkActions("sharedOut", flags({ everySharedRoot: false })).map(d => d.id)).not.toContain("unshare")
	})

	it("survives includesUndecryptable — pure-uuid disposition, same as trash", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ everySharedRoot: true, includesUndecryptable: true }))

		expect(descriptors.map(d => d.id)).toContain("unshare")
	})

	it("is absent from the trash variant's maximally-reduced menu, even nominally flagged", () => {
		expect(driveBulkActions("trash", flags({ everySharedRoot: true })).map(d => d.id)).not.toContain("unshare")
	})

	it("dispatches the unshare confirm dialog kind and is destructive-styled", () => {
		const unshare = driveBulkActions("sharedOut", flags({ everySharedRoot: true })).find(d => d.id === "unshare")

		expect(unshare).toMatchObject({ run: "dialog", dialogKind: "unshare", destructive: true, icon: UserMinusIcon })
	})

	it("is the last descriptor when present, after share (no bulk trash on sharedOut)", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ everySharedRoot: true, includesUndecryptable: false }))

		expect(descriptors.at(-1)?.id).toBe("unshare")
		expect(descriptors.at(-2)?.id).toBe("share")
	})
})

// sharedIn/sharedOut bulk mirrors the per-item menu's safe subset (item-menu.logic.ts) — no
// bulk favorite/move/trash on either shared surface, regardless of undecryptable/everySharedRoot.
// sharedOut keeps bulk share (canShareVariant); either surface keeps bulk unshare (everySharedRoot).
describe("driveBulkActions — shared-surface safe subset (sharedIn/sharedOut)", () => {
	it("sharedOut, not everySharedRoot: share only", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ includesUndecryptable: false, everySharedRoot: false }))

		expect(descriptors.map(d => d.id)).toEqual(["share"])
	})

	it("sharedOut, everySharedRoot: share then unshare", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ includesUndecryptable: false, everySharedRoot: true }))

		expect(descriptors.map(d => d.id)).toEqual(["share", "unshare"])
	})

	it("sharedIn, not everySharedRoot: no bulk actions at all (no bulk info)", () => {
		const descriptors = driveBulkActions("sharedIn", flags({ includesUndecryptable: false, everySharedRoot: false }))

		expect(descriptors).toEqual([])
	})

	it("sharedIn, everySharedRoot: unshare only", () => {
		const descriptors = driveBulkActions("sharedIn", flags({ includesUndecryptable: false, everySharedRoot: true }))

		expect(descriptors.map(d => d.id)).toEqual(["unshare"])
	})

	it("neither shared surface ever offers favorite/move/trash, undecryptable or everySharedRoot combined any way", () => {
		for (const variant of ["sharedIn", "sharedOut"] as const) {
			for (const includesUndecryptable of [false, true]) {
				for (const everySharedRoot of [false, true]) {
					const ids = driveBulkActions(variant, flags({ includesUndecryptable, everySharedRoot })).map(d => d.id)

					expect(ids.filter(id => id === "favorite" || id === "move" || id === "trash")).toEqual([])
				}
			}
		}
	})
})
