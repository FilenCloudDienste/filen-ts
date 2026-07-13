import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"

// Same mock boundary as itemMenu.test.ts: itemActions.ts pulls in itemMenu.logic.ts, which imports
// drive/lib/download.ts (startDownloads) — unresolvable/unwanted under node vitest.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { photosItemActions } from "@/features/photos/lib/itemActions"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("photo"),
		parent: testUuid("root"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "beach.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
}

function photoItem(overrides: Partial<File> = {}): PhotoItem {
	const item = narrowItem(mockFile(overrides))

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

function ids(item: PhotoItem): string[] {
	return photosItemActions(item).map(descriptor => descriptor.id)
}

describe("photosItemActions (photos per-item menu gating)", () => {
	it("offers rename/favorite/versions/info/download/share/publicLink/copyLink/trash, in that order", () => {
		expect(ids(photoItem())).toEqual(["rename", "favorite", "versions", "info", "download", "share", "publicLink", "copyLink", "trash"])
	})

	it("never offers move — mobile hides Move from its own photos context, and photos has no navigation context to move from", () => {
		expect(ids(photoItem())).not.toContain("move")
	})

	it("never offers color — a photos item is always a file, never a directory", () => {
		expect(ids(photoItem())).not.toContain("color")
	})

	it("never offers unshare/import/restore/deletePermanently — photos items are always owned, non-trashed, non-shared", () => {
		const forbidden = ["unshare", "import", "restore", "deletePermanently"]

		for (const id of ids(photoItem())) {
			expect(forbidden).not.toContain(id)
		}
	})

	it("favorite descriptor labels 'Favorite' when not yet favorited, 'Unfavorite' once it is", () => {
		const notFavorited = photosItemActions(photoItem({ favorited: false })).find(d => d.id === "favorite")
		const favorited = photosItemActions(photoItem({ favorited: true })).find(d => d.id === "favorite")

		expect(notFavorited?.labelKey).toBe("driveActionFavorite")
		expect(favorited?.labelKey).toBe("driveActionUnfavorite")
	})

	it("favorite runs directly (no dialog); every other descriptor dispatches a dialog kind", () => {
		const descriptors = photosItemActions(photoItem())
		const favorite = descriptors.find(d => d.id === "favorite")

		expect(favorite?.run).toBe("direct")

		for (const descriptor of descriptors) {
			if (descriptor.id === "favorite" || descriptor.id === "download") {
				continue
			}

			expect(descriptor.run).toBe("dialog")
		}
	})

	it("publicLink and copyLink both dispatch the link dialog kind", () => {
		const descriptors = photosItemActions(photoItem())

		expect(descriptors.find(d => d.id === "publicLink")).toMatchObject({ run: "dialog", dialogKind: "link" })
		expect(descriptors.find(d => d.id === "copyLink")).toMatchObject({ run: "dialog", dialogKind: "link" })
	})

	it("trash dispatches the trash confirm dialog and is non-destructive-styled (recoverable)", () => {
		const trash = photosItemActions(photoItem()).find(d => d.id === "trash")

		expect(trash).toMatchObject({ run: "dialog", dialogKind: "trash" })
		expect(trash?.destructive).toBeFalsy()
	})

	// isPhotoItem (predicate.ts) already guarantees decrypted meta — an undecryptable item can never
	// reach this menu at all, so photosItemActions carries no undecryptable branch of its own (unlike
	// driveItemActions). The invariant itself is pinned by photosPredicate.test.ts; this only documents
	// that photosItemActions makes no attempt to gate for it.
	it("returns a fresh array each call", () => {
		const first = photosItemActions(photoItem())
		const second = photosItemActions(photoItem())

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})
