import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { StarIcon, StarOffIcon, FolderInputIcon, UsersIcon, UserMinusIcon, Trash2Icon, RotateCcwIcon, DownloadIcon } from "lucide-react"
import type { Dir, File } from "@filen/sdk-rs"
import { type DriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// bulkActionBar.logic.ts imports features/drive/lib/download.ts (for startDownloads), which in turn touches
// the worker client and query client — unresolvable/unwanted under node vitest, mirrors
// download.test.ts's own mock boundary. startDownloads is replaced, since actually running
// it would reach the (also mocked) worker.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { startDownloadsMock } = vi.hoisted(() => ({ startDownloadsMock: vi.fn() }))

vi.mock("@/features/drive/lib/download", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/download")>()
	return { ...actual, startDownloads: startDownloadsMock }
})

// isFsaAvailable reads `window`, absent entirely under node vitest (a real call would throw) — kept
// REAL otherwise (via importOriginal). isBulkDownloadEnabled no longer calls it at all (the
// service-worker zip path made download's enabled gate unconditional) — stubbed to both true and
// false below purely to prove that value no longer changes the outcome.
const { isFsaAvailableMock } = vi.hoisted(() => ({ isFsaAvailableMock: vi.fn() }))

vi.mock("@/features/drive/lib/saveDownload", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/saveDownload")>()
	return { ...actual, isFsaAvailable: isFsaAvailableMock }
})

import { driveBulkActions, isBulkDownloadEnabled, startBulkDownload } from "@/features/drive/components/bulkActionBar.logic"

beforeEach(() => {
	isFsaAvailableMock.mockReturnValue(false)
})

// Local fixtures mirror itemMenu.test.ts's own per-file convention.
function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function fileItem(overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

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

// Pins the shared per-action label + icon facts (factored into ACTION_DEFS) so a drift in either the
// map or a builder's reference surfaces here — the id-only lists elsewhere prove ordering/gating but
// never which label or icon a bulk descriptor carries.
function facts(
	variant: Parameters<typeof driveBulkActions>[0],
	selection: DriveSelectionFlags
): { id: string; labelKey: string; icon: unknown }[] {
	return driveBulkActions(variant, selection).map(descriptor => ({
		id: descriptor.id,
		labelKey: descriptor.labelKey,
		icon: descriptor.icon
	}))
}

// Every descriptor derived from ACTION_DEFS, pinned to its label + icon across the surfaces it
// appears on: drive (favorite/move/share/download/trash), the favorited-state toggle, trash
// (restoreSelected/delete), and sharedOut everySharedRoot (unshare). A wrong ACTION_DEFS entry or a
// mis-wired builder reference fails here.
describe("driveBulkActions — descriptor label/icon facts (ACTION_DEFS drift guard)", () => {
	it("drive variant, none favorited: each descriptor carries its expected label and icon", () => {
		expect(facts("drive", flags({ includesFavorited: false, includesUndecryptable: false }))).toEqual([
			{ id: "favorite", labelKey: "driveActionFavorite", icon: StarIcon },
			{ id: "move", labelKey: "driveActionMove", icon: FolderInputIcon },
			{ id: "share", labelKey: "driveActionShare", icon: UsersIcon },
			{ id: "download", labelKey: "driveActionDownload", icon: DownloadIcon },
			{ id: "trash", labelKey: "driveActionTrash", icon: Trash2Icon }
		])
	})

	it("drive variant, any favorited: favorite toggles to the Unfavorite label and star-off icon", () => {
		expect(facts("drive", flags({ includesFavorited: true, includesUndecryptable: false }))).toContainEqual({
			id: "favorite",
			labelKey: "driveActionUnfavorite",
			icon: StarOffIcon
		})
	})

	it("trash variant: restoreSelected/delete carry their expected labels and icons", () => {
		expect(facts("trash", flags())).toEqual([
			{ id: "restoreSelected", labelKey: "driveActionRestore", icon: RotateCcwIcon },
			{ id: "delete", labelKey: "driveActionDeletePermanently", icon: Trash2Icon }
		])
	})

	it("sharedOut everySharedRoot: the unshare descriptor carries its expected label and icon", () => {
		expect(facts("sharedOut", flags({ everySharedRoot: true, includesUndecryptable: false }))).toContainEqual({
			id: "unshare",
			labelKey: "driveActionUnshare",
			icon: UserMinusIcon
		})
	})
})

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
		"%s variant, decryptable selection, none favorited: favorite, move, share, download, trash in that order",
		variant => {
			const descriptors = driveBulkActions(variant, flags({ includesFavorited: false, includesUndecryptable: false }))

			expect(descriptors.map(d => d.id)).toEqual(["favorite", "move", "share", "download", "trash"])
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
		"%s variant, any undecryptable item: favorite/move/share/download are suppressed, trash remains",
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
// sharedRootDirectory/sharedRootFile arms), mirroring itemMenu.logic.ts's own per-item type gate.
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

	it("is the last descriptor when present, after share and download (no bulk trash on sharedOut)", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ everySharedRoot: true, includesUndecryptable: false }))

		expect(descriptors.map(d => d.id)).toEqual(["share", "download", "unshare"])
	})
})

// sharedIn/sharedOut bulk mirrors the per-item menu's safe subset (itemMenu.logic.ts) — no
// bulk favorite/move/trash on either shared surface, regardless of undecryptable/everySharedRoot.
// sharedOut keeps bulk share (canShareVariant); either surface keeps bulk unshare (everySharedRoot).
describe("driveBulkActions — shared-surface safe subset (sharedIn/sharedOut)", () => {
	it("sharedOut, not everySharedRoot: share + download", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ includesUndecryptable: false, everySharedRoot: false }))

		expect(descriptors.map(d => d.id)).toEqual(["share", "download"])
	})

	it("sharedOut, everySharedRoot: share, download, then unshare", () => {
		const descriptors = driveBulkActions("sharedOut", flags({ includesUndecryptable: false, everySharedRoot: true }))

		expect(descriptors.map(d => d.id)).toEqual(["share", "download", "unshare"])
	})

	it("sharedIn, not everySharedRoot: download only (download mutates nothing, so it survives sharedIn's owner-mutating gate)", () => {
		const descriptors = driveBulkActions("sharedIn", flags({ includesUndecryptable: false, everySharedRoot: false }))

		expect(descriptors.map(d => d.id)).toEqual(["download"])
	})

	it("sharedIn, everySharedRoot: download then unshare", () => {
		const descriptors = driveBulkActions("sharedIn", flags({ includesUndecryptable: false, everySharedRoot: true }))

		expect(descriptors.map(d => d.id)).toEqual(["download", "unshare"])
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

// The download descriptor itself (icon/label/run) — driveBulkActions' own presence/ordering is
// already covered by the describe blocks above; this isolates its shape.
describe("driveBulkActions — download descriptor shape", () => {
	it("is a direct action with the download icon and label", () => {
		const download = driveBulkActions("drive", flags({ includesUndecryptable: false })).find(d => d.id === "download")

		expect(download).toMatchObject({ run: "direct", labelKey: "driveActionDownload", icon: DownloadIcon })
	})
})

// Download's ENABLED state (distinct from its presence in driveBulkActions) — mirrored in
// itemMenu.logic.ts and the drive keymap: enabled iff the selection is non-empty. The service-worker
// zip path removed the isFsaAvailable() requirement a dir/multi selection used to need — both FSA
// states are still exercised below as documentation that its value no longer changes the outcome.
describe("isBulkDownloadEnabled", () => {
	it("is enabled for a single-file selection, regardless of FSA availability", () => {
		expect(isBulkDownloadEnabled([fileItem()])).toBe(true)
	})

	it("is enabled for a multi-file selection on a non-FSA browser — the sw zip route covers it", () => {
		isFsaAvailableMock.mockReturnValue(false)

		expect(isBulkDownloadEnabled([fileItem(), fileItem()])).toBe(true)
	})

	it("is enabled for a single-directory selection on a non-FSA browser — the sw zip route covers it", () => {
		isFsaAvailableMock.mockReturnValue(false)

		expect(isBulkDownloadEnabled([dirItem()])).toBe(true)
	})

	it("is enabled for a multi-file selection when isFsaAvailable() is true", () => {
		isFsaAvailableMock.mockReturnValue(true)

		expect(isBulkDownloadEnabled([fileItem(), fileItem()])).toBe(true)
	})

	it("is enabled for a single-directory selection when isFsaAvailable() is true", () => {
		isFsaAvailableMock.mockReturnValue(true)

		expect(isBulkDownloadEnabled([dirItem()])).toBe(true)
	})

	it("is disabled for an empty selection even when isFsaAvailable() is true", () => {
		isFsaAvailableMock.mockReturnValue(true)

		expect(isBulkDownloadEnabled([])).toBe(false)
	})
})

describe("startBulkDownload", () => {
	it("calls startDownloads with the selection, synchronously (gesture-preserving)", () => {
		const items = [fileItem()]

		startBulkDownload(items)

		expect(startDownloadsMock).toHaveBeenCalledWith(items)
	})
})
