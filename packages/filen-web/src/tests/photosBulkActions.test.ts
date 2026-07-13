import { describe, expect, it } from "vitest"
import { photosBulkActions } from "@/features/photos/lib/bulkActions"
import { type DriveSelectionFlags } from "@/features/drive/lib/selectionFlags"

function flags(overrides: Partial<DriveSelectionFlags> = {}): DriveSelectionFlags {
	return {
		count: 2,
		includesFavorited: false,
		everyFile: true,
		everyDirectory: false,
		includesUndecryptable: false,
		everySharedRoot: false,
		...overrides
	}
}

function ids(f: DriveSelectionFlags): string[] {
	return photosBulkActions(f).map(descriptor => descriptor.id)
}

describe("photosBulkActions (photos bulk-action bar gating)", () => {
	it("offers favorite/download/share/trash, in that order", () => {
		expect(ids(flags())).toEqual(["favorite", "download", "share", "trash"])
	})

	it("never offers move — mobile hides Move from its own photos context", () => {
		expect(ids(flags())).not.toContain("move")
	})

	it("never offers unshare/restoreSelected/delete/disableLink — none apply to a flat, owned, non-trashed photos selection", () => {
		const forbidden = ["unshare", "restoreSelected", "delete", "disableLink"]

		for (const id of ids(flags())) {
			expect(forbidden).not.toContain(id)
		}
	})

	it("favorite labels 'Favorite' when nothing in the selection is favorited yet", () => {
		const descriptor = photosBulkActions(flags({ includesFavorited: false })).find(d => d.id === "favorite")

		expect(descriptor?.labelKey).toBe("driveActionFavorite")
	})

	it("favorite labels 'Unfavorite' (SET semantics) once ANY selected item is favorited", () => {
		const descriptor = photosBulkActions(flags({ includesFavorited: true })).find(d => d.id === "favorite")

		expect(descriptor?.labelKey).toBe("driveActionUnfavorite")
	})

	it("favorite and download run directly; share and trash dispatch their own dialog kinds", () => {
		const descriptors = photosBulkActions(flags())

		expect(descriptors.find(d => d.id === "favorite")).toMatchObject({ run: "direct" })
		expect(descriptors.find(d => d.id === "download")).toMatchObject({ run: "direct" })
		expect(descriptors.find(d => d.id === "share")).toMatchObject({ run: "dialog", dialogKind: "share" })
		expect(descriptors.find(d => d.id === "trash")).toMatchObject({ run: "dialog", dialogKind: "trash" })
	})

	it("trash is non-destructive-styled (recoverable, mirrors the per-item menu's own trash)", () => {
		const trash = photosBulkActions(flags()).find(d => d.id === "trash")

		expect(trash?.destructive).toBeFalsy()
	})

	it("gating is identical regardless of includesUndecryptable/everySharedRoot — a photos selection can never carry either", () => {
		expect(ids(flags({ includesUndecryptable: true }))).toEqual(ids(flags()))
		expect(ids(flags({ everySharedRoot: true }))).toEqual(ids(flags()))
	})

	it("returns a fresh array each call", () => {
		const first = photosBulkActions(flags())
		const second = photosBulkActions(flags())

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})
