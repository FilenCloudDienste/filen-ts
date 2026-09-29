import * as Comlink from "comlink"
import type { Dir, DirColor, File, FileVersion } from "@filen/sdk-rs"
import { removeByUuid } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { accountQueryGet, markAccountStale } from "@/queries/account"
import {
	cachedListing,
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	batchListingPatches,
	findOwnedListingItem,
	flatListingQueryUpdate,
	driveItemLinkStatusQueryUpdate,
	fetchDriveItemLinkStatus,
	driveItemLinkStatusQueryKey,
	markDriveListingStale,
	markFlatListingStale,
	normalizeParentUuid,
	type DriveItemLinkStatus,
	type DriveListingParams
} from "@/features/drive/queries/drive"
import {
	narrowItem,
	upsertDriveItem,
	asDirectoryOrFile,
	isDirectoryItem,
	withColor,
	withFavorited,
	withNameOf,
	type DriveItem
} from "@/features/drive/lib/item"
import { dropFromClipboard, followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { asErrorDTO, plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { runBulk, runBulkOutcomes, type BulkOutcome } from "@/lib/actions/bulk"
import { attemptOp, runOp, type ActionOutcome as GenericActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"
import { emitBranchChange } from "@/features/drive/lib/branchChanges"

export type { VoidActionOutcome }

export type DirectoryItem = Extract<DriveItem, { type: "directory" }>
export type FileItem = Extract<DriveItem, { type: "file" }>

export type ActionOutcome = GenericActionOutcome<DriveItem>

// The account query is warm by the time any drive listing can render (the rail/account menu fetch
// it eagerly) — a cache miss degrades to "", a value no real directory uuid or the null root
// sentinel can ever equal, so normalizeParentUuid becomes a harmless pass-through rather than
// needing a guard at every call site. Exported for previewOverlay.tsx's own save flow — the
// .logic.ts split keeps previewSave.logic.ts itself framework-free, so its rootUuid dependency is
// resolved by the caller instead, same as every other action here.
export function currentRootUuid(): string {
	return accountQueryGet()?.rootDirUuid ?? ""
}

// A directory row keeps the colour it holds: an action's result carries the colour of the row the action
// started from, which may be outdated, and a move or restore echo carries none.
function keepingColor(row: DriveItem, item: DriveItem): DriveItem {
	return row.type === "directory" && item.type === "directory" && row.data.color !== item.data.color
		? { ...item, data: { ...item.data, color: row.data.color } }
		: item
}

// A directory row with the colour a current listing holds, read before any fan-out strips that row. With
// none, colorKnown is false and a listing the row joins stops counting as current, so its next mount or
// focus reads it again.
function withCurrentColor(item: DriveItem): { item: DriveItem; colorKnown: boolean } {
	if (item.type !== "directory") {
		return { item, colorKnown: true }
	}

	const found = findOwnedListingItem(item.data.uuid)

	return found?.current === true ? { item: keepingColor(found.item, item), colorKnown: true } : { item, colorKnown: false }
}

// ── Rename ───────────────────────────────────────────────────────────────

export async function renameItem(item: DriveItem, newName: string): Promise<ActionOutcome> {
	const base = asDirectoryOrFile(item)
	const outcome = await attemptOp<Dir | File>(
		base.type === "directory" ? sdkApi.renameDirectory(base.data, newName) : sdkApi.renameFile(base.data, newName)
	)

	if (outcome.status === "error") {
		return outcome
	}

	const updated = narrowItem(outcome.item)
	// A rename never changes listing membership (same uuid, same parent) — a global replace-in-place covers
	// the drive-parent listing too, and also fans the new name out to a favorited/recent/shared copy of the
	// same row, which a narrow per-parent patch never reached; each row takes only the name.
	driveListingQueryUpdateGlobal({ type: "replace", uuid: updated.data.uuid, replace: row => withNameOf(row, updated) })
	followClipboardItem(updated)
	// Breadcrumb name cache — this item's uuid may appear as an ancestor segment on some open path.
	// Fire-and-forget: the optimistic patch above already covers the success outcome, so a rejection
	// here must not delay it or escape renameItem uncaught.
	void queryClient.invalidateQueries({ queryKey: ["drive", "names"] })

	return { status: "success", item: updated }
}

// ── Move (bulk) ──────────────────────────────────────────────────────────

export function moveItems(items: DriveItem[], targetParentUuid: string | null): Promise<BulkOutcome<DriveItem>> {
	const rootUuid = currentRootUuid()

	return batchListingPatches(() =>
		runBulk(items, async item => {
			const base = asDirectoryOrFile(item)
			const moved = await runOp<Dir | File>(
				base.type === "directory" ? sdkApi.moveDirectory(base.data, targetParentUuid) : sdkApi.moveFile(base.data, targetParentUuid)
			)

			const movedItem = narrowItem(moved)

			patchMovedItem(movedItem, rootUuid)
			followClipboardItem(movedItem)
		})
	)
}

function movedRowChange({ variant, uuid }: DriveListingParams): "replace" | "remove" | undefined {
	switch (variant) {
		case "recents":
		case "favorites":
		case "links":
			return "replace"
		case "sharedIn":
		case "sharedOut":
			return uuid === null ? undefined : "remove"
		case "drive":
		case "trash":
			return "remove"
	}
}

// A move changes only the row's parent. It leaves every directory listing and the trash (a move always
// lands outside it) for its new parent's; a favorite, recent or linked row stays where it is with the new
// parent and its own colour. A shared root row stays shared; a nested shared listing loses a child that
// moved out of it. Exported: the realtime fileMove/folderMove handlers apply the same rule.
export function patchMovedItem(moved: DriveItem, rootUuid: string): void {
	const { item, colorKnown } = withCurrentColor(moved)
	const parentUuid = normalizeParentUuid(item.data.parent, rootUuid)

	driveListingQueryUpdateGlobal(
		{ type: "replace", uuid: item.data.uuid, replace: row => keepingColor(row, item) },
		params => movedRowChange(params) === "replace"
	)
	driveListingQueryUpdateGlobal({ type: "remove", uuid: item.data.uuid }, params => movedRowChange(params) === "remove")
	driveListingQueryUpdate(parentUuid, { type: "upsert", items: [item] })

	if (!colorKnown) {
		markDriveListingStale(parentUuid)
	}

	if (item.type === "directory") {
		emitBranchChange({ type: "moved", uuid: item.data.uuid, parentUuid })
	}
}

// ── Trash (bulk) ─────────────────────────────────────────────────────────

// Trash is a membership listing of its own, not merely an absence from the normal ones: a trashed item
// leaves every normal listing and JOINS this one. A removal fan-out must be followed by this insert —
// otherwise a trash performed here or echoed from another device makes the row invisible in an
// already-open trash until its next refetch — and need not sweep the trash key itself, since the insert
// replaces a same-uuid row there. Dedups on uuid ALONE rather than upsertDriveItem's name-collision
// rule (trash aggregates across directories, so two trashed items can legitimately share a name — same
// reasoning as the favorites listing), and `prev === undefined` (nobody has opened Trash) stays a no-op
// so an unfetched listing is never conjured. Exported: the realtime fileTrash/folderTrash handlers apply the same rule.
// A directory row joining with an unknown colour (withCurrentColor) stops the listing counting as current.
export function insertIntoTrashListing(item: DriveItem, colorKnown: boolean): void {
	flatListingQueryUpdate("trash", { type: "append", items: [item] })

	if (!colorKnown) {
		markFlatListingStale("trash")
	}
}

export function trashItems(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	return batchListingPatches(() =>
		runBulk(items, async item => {
			const base = asDirectoryOrFile(item)
			const { item: trashed, colorKnown } = withCurrentColor(
				narrowItem(
					await runOp<Dir | File>(base.type === "directory" ? sdkApi.trashDirectory(base.data) : sdkApi.trashFile(base.data))
				)
			)

			// Every listing but the trash loses the row, then the SDK's own post-trash shape joins the trash.
			driveListingQueryUpdateGlobal({ type: "remove", uuid: item.data.uuid }, ({ variant }) => variant !== "trash")
			insertIntoTrashListing(trashed, colorKnown)
			dropFromClipboard(item)

			if (base.type === "directory") {
				emitBranchChange({ type: "trashed", uuid: item.data.uuid })
			}
		})
	)
}

// ── Restore (bulk) ───────────────────────────────────────────────────────

// A restore brings the item out of the trash into its parent. Exported: the realtime fileRestore/
// folderRestore handlers apply the same rule.
export function patchRestoredItem(restored: DriveItem, rootUuid: string): { item: DriveItem; colorKnown: boolean } {
	const resolved = withCurrentColor(restored)
	const parentUuid = normalizeParentUuid(resolved.item.data.parent, rootUuid)

	// Global remove FIRST: it fans out over every currently-cached listing, including the
	// destination key the next line populates — running it after that upsert would strip the
	// just-restored row right back out (uuid is preserved across a restore).
	driveListingQueryUpdateGlobal({ type: "remove", uuid: resolved.item.data.uuid })
	driveListingQueryUpdate(parentUuid, { type: "upsert", items: [resolved.item] })

	if (!resolved.colorKnown) {
		markDriveListingStale(parentUuid)
	}

	return resolved
}

export function restoreItems(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	const rootUuid = currentRootUuid()

	return batchListingPatches(() =>
		runBulk(items, async item => {
			const base = asDirectoryOrFile(item)
			const restored = await runOp<Dir | File>(
				base.type === "directory" ? sdkApi.restoreDirectory(base.data) : sdkApi.restoreFile(base.data)
			)

			patchRestoredItem(narrowItem(restored), rootUuid)
		})
	)
}

// ── Delete permanently (bulk) ────────────────────────────────────────────

export function deleteItemsPermanently(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	return batchListingPatches(() =>
		runBulk(items, async item => {
			const base = asDirectoryOrFile(item)
			await runOp(base.type === "directory" ? sdkApi.deleteDirectoryPermanently(base.data) : sdkApi.deleteFilePermanently(base.data))

			// The worker's own deleteDirectoryPermanently already evicts the directory cache worker-side
			// (that cache is worker-realm private, unreachable from here) — this is only the listing side.
			driveListingQueryUpdateGlobal({ type: "remove", uuid: item.data.uuid })
			dropFromClipboard(item)
			markAccountStale()
		})
	)
}

// ── Empty trash ──────────────────────────────────────────────────────────

export async function emptyTrash(): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.emptyTrash())

	if (outcome.status === "error") {
		return outcome
	}

	// Trashed items live in no other listing, so this alone empties the whole surface.
	flatListingQueryUpdate("trash", () => [])
	markAccountStale()

	return { status: "success" }
}

// ── Favorite ─────────────────────────────────────────────────────────────

// Favorites is its own membership listing, not merely a flag on an existing row: favoriting must be
// able to ADD a row that listing never had, unfavoriting must REMOVE it. The add path dedups on uuid
// ALONE rather than upsertDriveItem's name-collision rule — favorites aggregates across every
// directory, so two distinct items from different parents can legitimately share a name, and every
// other upsert call site targets a single drive-parent where the backend already enforces
// name-uniqueness. `prev === undefined` (nobody has opened Favorites) stays a no-op so an unfetched
// listing is never conjured. Exported: the realtime ItemFavorite handler (lib/socketHandlers.ts)
// applies the identical membership rule for a change made on another device. A directory row joining with
// an unknown colour (withCurrentColor) stops the listing counting as current.
export function patchFavoritesListing(favorited: boolean, item: DriveItem, colorKnown: boolean): void {
	flatListingQueryUpdate("favorites", favorited ? { type: "append", items: [item] } : { type: "remove", uuid: item.data.uuid })

	if (favorited && !colorKnown) {
		markFlatListingStale("favorites")
	}
}

// Shared cache-patch tail for both the single-item toggle and the bulk SET below — factored out so
// the favorites-membership rule has exactly one implementation. Takes `favorited` explicitly rather
// than reading `result.data.favorited` so a caller applying the same target across a whole selection
// (setFavoritedItems) never has to reconstruct it from the item.
function applyFavoritePatch(favorited: boolean, result: DriveItem): void {
	const joining = favorited ? withCurrentColor(result) : { item: result, colorKnown: true }

	// The global flag patch only ever updates rows that already exist, each taking only the flag; membership
	// is the other half.
	driveListingQueryUpdateGlobal({ type: "replace", uuid: result.data.uuid, replace: row => withFavorited(row, favorited) })
	patchFavoritesListing(favorited, joining.item, joining.colorKnown)
	followClipboardItem(result)
}

export async function toggleFavorite(item: DriveItem): Promise<ActionOutcome> {
	const nextFavorited = !item.data.favorited

	const outcome = await attemptOp<Dir | File>(sdkApi.setFavorited(item.data, nextFavorited))

	if (outcome.status === "error") {
		return outcome
	}

	const result = narrowItem(outcome.item)

	applyFavoritePatch(nextFavorited, result)

	return { status: "success", item: result }
}

// Bulk favorite is a SET, not a per-item toggle (mobile parity — see driveSelectors.ts/
// headerMenuBuilders.ts's buildBulkActionMenu): the bulk-action bar computes one target
// (`!flags.includesFavorited`) from the whole selection and applies it to every item, rather than
// each item flipping its own current flag independently.
export function setFavoritedItems(items: DriveItem[], favorited: boolean): Promise<BulkOutcome<DriveItem>> {
	return batchListingPatches(() =>
		runBulk(items, async item => {
			const result = narrowItem(await runOp<Dir | File>(sdkApi.setFavorited(item.data, favorited)))
			applyFavoritePatch(favorited, result)
		})
	)
}

// ── Color ────────────────────────────────────────────────────────────────

export async function setColor(dir: DirectoryItem, color: DirColor): Promise<ActionOutcome> {
	const outcome = await attemptOp(sdkApi.setDirectoryColor(dir.data, color))

	if (outcome.status === "error") {
		return outcome
	}

	const colored = outcome.item

	const updated = narrowItem(colored)
	driveListingQueryUpdateGlobal({ type: "replace", uuid: updated.data.uuid, replace: row => withColor(row, colored.color) })
	followClipboardItem(updated)

	return { status: "success", item: updated }
}

// ── File versions ────────────────────────────────────────────────────────

export async function restoreVersion(file: FileItem, version: FileVersion): Promise<ActionOutcome> {
	const outcome = await attemptOp(sdkApi.restoreFileVersionOp(file.data, version))

	if (outcome.status === "error") {
		return outcome
	}

	const restored = outcome.item

	// Content change, not a move: the returned file carries a ROTATED uuid, replacing the old one in
	// the SAME listing. upsertDriveItem's own dedup can't be relied on alone — an undecryptable row
	// has no name to match against — so the stale uuid is dropped explicitly as well.
	const updated = narrowItem(restored)
	const oldUuid = file.data.uuid
	driveListingQueryUpdate(normalizeParentUuid(file.data.parent, currentRootUuid()), prev =>
		removeByUuid(upsertDriveItem(prev, updated), oldUuid)
	)
	followClipboardItem(updated, oldUuid)

	return { status: "success", item: updated }
}

// deleteFileVersionOp takes only the version and deletes by ITS uuid alone — for every version
// except the live one that's just history, but the live version's uuid IS the file's own current
// storage blob (see restoreVersion/isCurrentVersion), so deleting it would destroy the file's
// current content, not just a historical entry. The versions panel already disables this per row;
// this guard is the same rule enforced again at the library boundary so no future caller can reach
// the live-blob delete by skipping the UI (defense-in-depth). A `file` read before another device saved
// the file again holds a superseded uuid, so the version is also live when the file's directory listing,
// once refetched, holds it as a row.
function isLiveVersion(file: FileItem, version: FileVersion): boolean {
	if (version.uuid === file.data.uuid) {
		return true
	}

	const siblings = cachedListing("drive", normalizeParentUuid(file.data.parent, currentRootUuid()))

	return siblings?.some(row => row.data.uuid === version.uuid) === true
}

export async function deleteVersion(file: FileItem, version: FileVersion): Promise<VoidActionOutcome> {
	if (isLiveVersion(file, version)) {
		return { status: "error", dto: plainErrorDTO(i18n.t("drive:driveVersionsDeleteLiveBlocked")) }
	}

	const outcome = await attemptOp(sdkApi.deleteFileVersionOp(version))

	if (outcome.status === "error") {
		return outcome
	}

	markAccountStale()

	return { status: "success" }
}

// Bulk delete — the versions panel's own multi-select "Delete selected" and "Delete all" actions.
// Runs deleteVersion per version (its own live-blob guard applies here too, defense-in-depth even
// though the panel's selection UI never lets the live version be selected in the first place), one
// failure never aborting the rest — same partial-success shape as every other bulk helper in this
// file.
export function deleteVersions(file: FileItem, versions: FileVersion[]): Promise<BulkOutcome<FileVersion>> {
	return runBulkOutcomes(versions, version => deleteVersion(file, version))
}

// ── Public link ──────────────────────────────────────────────────────────
// A link never changes the item's listing presence (no listing-cache patch below, unlike every write
// above) — only the link-status query itself needs patching, so a reopened panel reflects the change
// without a redundant re-fetch.

export type LinkActionOutcome = { status: "success"; link: DriveItemLinkStatus } | { status: "error"; dto: ErrorDTO }

// The dir tree re-encrypt crosses Comlink with a progress callback — Comlink.proxy marks it so the
// worker can invoke it directly instead of the call attempting (and failing) to structured-clone a
// function.
export async function createLink(
	item: DriveItem,
	onProgress: (downloadedBytes: number, totalBytes: number | undefined) => void
): Promise<LinkActionOutcome> {
	const base = asDirectoryOrFile(item)
	let link: DriveItemLinkStatus

	try {
		link =
			base.type === "directory"
				? { type: "directory", status: await runOp(sdkApi.createDirectoryLink(base.data, Comlink.proxy(onProgress))) }
				: { type: "file", status: await runOp(sdkApi.createFileLink(base.data)) }
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	driveItemLinkStatusQueryUpdate(item.data.uuid, link)

	return { status: "success", link }
}

// `next` carries the merged object (see linkDialog.logic.ts's buildLinkUpdate) — the item/link type
// pairing is re-verified here rather than trusted blindly, since the two are independently-typed
// parameters the type system can't itself correlate.
export async function updateLink(item: DriveItem, next: DriveItemLinkStatus): Promise<LinkActionOutcome> {
	const base = asDirectoryOrFile(item)
	let link: DriveItemLinkStatus

	try {
		if (base.type === "directory" && next.type === "directory") {
			link = { type: "directory", status: await runOp(sdkApi.updateDirectoryLink(base.data, next.status)) }
		} else if (base.type === "file" && next.type === "file") {
			link = { type: "file", status: await runOp(sdkApi.updateFileLink(base.data, next.status)) }
		} else {
			throw new Error("Item/link type mismatch")
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	driveItemLinkStatusQueryUpdate(item.data.uuid, link)

	return { status: "success", link }
}

// Asymmetric args (verified against the installed .d.ts, see sdk.worker.ts's own comment on this):
// removing a directory's link only needs the directory; removing a file's link also needs the live
// link object, so the caller's status is threaded through as `current` (the directory's, if given, is
// only checked against the item). Shared by the single-item panel (disableLink below) and the links-root
// bulk action (disableLinks) so the two paths can never drift on what "disabled" does to the cache: the
// item's own status query clears, AND — a disabled link no longer belongs in the links-root aggregation —
// it's dropped from that listing too (the single-item panel used to skip this half; a disabled link left a
// stale row behind until the listing's next refetch).
async function disableLinkForItem(item: DriveItem, current: DriveItemLinkStatus | undefined): Promise<VoidActionOutcome> {
	const base = asDirectoryOrFile(item)

	try {
		if (base.type === "directory" && (current === undefined || current.type === "directory")) {
			await runOp(sdkApi.removeDirectoryLink(base.data))
		} else if (base.type === "file" && current?.type === "file") {
			await runOp(sdkApi.removeFileLink(base.data, current.status))
		} else {
			throw new Error("Item/link type mismatch")
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	driveItemLinkStatusQueryUpdate(item.data.uuid, null)
	// Through the patch path, so a read under way drops the row too and a stale mark stays set.
	flatListingQueryUpdate("links", { type: "remove", uuid: item.data.uuid })

	return { status: "success" }
}

export async function disableLink(item: DriveItem, current: DriveItemLinkStatus): Promise<VoidActionOutcome> {
	return disableLinkForItem(item, current)
}

// Bulk disable — the links-root multi-select's own "Disable public link" (mobile parity,
// headerMenuBuilders.ts's disableLinkSelected). A directory's link goes with no status read at all; a
// file's needs the link itself, taken from the status the link panel may already hold (a links-root row
// carries none of its own) and read fresh only when it holds none. Only when that removal fails is the
// current status read: an item that has lost its link meanwhile (e.g. disabled from another tab/device
// moments earlier) counts as succeeded — there is nothing left to disable, and the listing still drops
// it — and a file's link replaced meanwhile is removed as it now is.
export function disableLinks(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	return batchListingPatches(() =>
		runBulkOutcomes(items, async (item): Promise<VoidActionOutcome> => {
			const isDirectory = isDirectoryItem(item)
			const held = isDirectory ? undefined : heldLinkStatus(item)
			let failure: VoidActionOutcome | undefined

			if (isDirectory || held !== undefined) {
				const outcome = await disableLinkForItem(item, held)

				if (outcome.status === "success") {
					return outcome
				}

				failure = outcome
			}

			const current = await fetchDriveItemLinkStatus(item)

			if (current === null) {
				flatListingQueryUpdate("links", { type: "remove", uuid: item.data.uuid })

				return { status: "success" }
			}

			// Tried again only with a file link replaced meanwhile: a directory's removal takes no status, and
			// the same link fails the same way.
			return failure !== undefined && (isDirectory || sameFileLink(held, current)) ? failure : disableLinkForItem(item, current)
		})
	)
}

// A link status some earlier read left cached, if it holds a link.
function heldLinkStatus(item: DriveItem): DriveItemLinkStatus | undefined {
	return queryClient.getQueryData<DriveItemLinkStatus | null>(driveItemLinkStatusQueryKey(item.data.uuid)) ?? undefined
}

function sameFileLink(held: DriveItemLinkStatus | undefined, current: DriveItemLinkStatus): boolean {
	return held?.type === "file" && current.type === "file" && held.status.linkUuid === current.status.linkUuid
}
