import * as Comlink from "comlink"
import type { Dir, DirColor, File, FileVersion, UserInfo } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import {
	driveListingQueryKey,
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	driveItemLinkStatusQueryUpdate,
	normalizeParentUuid,
	type DriveItemLinkStatus
} from "@/queries/drive"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/lib/drive/item"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { runBulk, type BulkOutcome } from "@/lib/drive/bulk"
import { runOp, type ActionOutcome as GenericActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { VoidActionOutcome }

export type DirectoryItem = Extract<DriveItem, { type: "directory" }>
export type FileItem = Extract<DriveItem, { type: "file" }>

export type ActionOutcome = GenericActionOutcome<DriveItem>

// The account query is warm by the time any drive listing can render (the rail/account menu fetch
// it eagerly) — a cache miss degrades to "", a value no real directory uuid or the null root
// sentinel can ever equal, so normalizeParentUuid becomes a harmless pass-through rather than
// needing a guard at every call site.
function currentRootUuid(): string {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.rootDirUuid ?? ""
}

function removeByUuid(items: DriveItem[], uuid: string): DriveItem[] {
	return items.filter(item => item.data.uuid !== uuid)
}

// Attribute-only refresh (a flag or color changed; identity and name did not) — replaces an
// existing row in place, never appends. Deliberately not upsertDriveItem: patched globally, an
// upsert would wrongly ADD the item to every currently-cached listing that never held it (trash,
// favorites, a sibling directory) instead of leaving an absent row absent.
function replaceIfPresent(items: DriveItem[], updated: DriveItem): DriveItem[] {
	return items.map(item => (item.data.uuid === updated.data.uuid ? updated : item))
}

// ── Rename ───────────────────────────────────────────────────────────────

export async function renameItem(item: DriveItem, newName: string): Promise<ActionOutcome> {
	let renamed: Dir | File
	try {
		renamed = await runOp<Dir | File>(
			item.type === "directory" ? sdkApi.renameDirectory(item.data, newName) : sdkApi.renameFile(item.data, newName)
		)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const updated = narrowItem(renamed)
	// A rename never changes listing membership (same uuid, same parent) — a global replace-in-place
	// covers the drive-parent listing too, and also fans the new name out to a favorited/recent copy
	// of the same row, which a narrow per-parent patch never reached.
	driveListingQueryUpdateGlobal(prev => replaceIfPresent(prev, updated))
	// Breadcrumb name cache — this item's uuid may appear as an ancestor segment on some open path.
	// Fire-and-forget: the optimistic patch above already covers the success outcome, so a rejection
	// here must not delay it or escape renameItem uncaught.
	void queryClient.invalidateQueries({ queryKey: ["drive", "names"] })

	return { status: "success", item: updated }
}

// ── Move (bulk) ──────────────────────────────────────────────────────────

export function moveItems(items: DriveItem[], targetParentUuid: string | null): Promise<BulkOutcome<DriveItem>> {
	const rootUuid = currentRootUuid()
	const normalizedTarget = normalizeParentUuid(targetParentUuid, rootUuid)

	return runBulk(items, async item => {
		const moved = await runOp<Dir | File>(
			item.type === "directory" ? sdkApi.moveDirectory(item.data, targetParentUuid) : sdkApi.moveFile(item.data, targetParentUuid)
		)
		const updated = narrowItem(moved)

		driveListingQueryUpdate(normalizeParentUuid(item.data.parent, rootUuid), prev => removeByUuid(prev, item.data.uuid))
		driveListingQueryUpdate(normalizedTarget, prev => upsertDriveItem(prev, updated))
	})
}

// ── Trash (bulk) ─────────────────────────────────────────────────────────

export function trashItems(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	return runBulk(items, async item => {
		await runOp<Dir | File>(item.type === "directory" ? sdkApi.trashDirectory(item.data) : sdkApi.trashFile(item.data))

		// Vanishes from wherever it was visible (drive/favorites/recents) — never optimistically added
		// to the trash listing itself, which refetches on open (accepted staleness).
		driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
	})
}

// ── Restore (bulk) ───────────────────────────────────────────────────────

export function restoreItems(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	const rootUuid = currentRootUuid()

	return runBulk(items, async item => {
		const restored = await runOp<Dir | File>(
			item.type === "directory" ? sdkApi.restoreDirectory(item.data) : sdkApi.restoreFile(item.data)
		)
		const updated = narrowItem(restored)

		// Global remove FIRST: it fans out over every currently-cached listing, including the
		// destination key the next line populates — running it after that upsert would strip the
		// just-restored row right back out (uuid is preserved across a restore).
		driveListingQueryUpdateGlobal(prev => removeByUuid(prev, updated.data.uuid))
		driveListingQueryUpdate(normalizeParentUuid(updated.data.parent, rootUuid), prev => upsertDriveItem(prev, updated))
	})
}

// ── Delete permanently (bulk) ────────────────────────────────────────────

export function deleteItemsPermanently(items: DriveItem[]): Promise<BulkOutcome<DriveItem>> {
	return runBulk(items, async item => {
		await runOp(item.type === "directory" ? sdkApi.deleteDirectoryPermanently(item.data) : sdkApi.deleteFilePermanently(item.data))

		// The worker's own deleteDirectoryPermanently already evicts the directory cache worker-side
		// (that cache is worker-realm private, unreachable from here) — this is only the listing side.
		driveListingQueryUpdateGlobal(prev => removeByUuid(prev, item.data.uuid))
	})
}

// ── Empty trash ──────────────────────────────────────────────────────────

export async function emptyTrash(): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.emptyTrash())
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// driveListingQueryUpdate is hardcoded to variant "drive" and driveListingQueryUpdateGlobal has no
	// way to target one key — neither can single out the trash listing, so patch its exact key
	// directly. Trashed items live in no other listing, so this alone empties the whole surface.
	queryClient.setQueryData(driveListingQueryKey({ variant: "trash", uuid: null }), [])

	return { status: "success" }
}

// ── Favorite ─────────────────────────────────────────────────────────────

// Shared cache-patch tail for both the single-item toggle and the bulk SET below — factored out so
// the favorites-membership rule (favoriting ADDS a row that listing never had, unfavoriting REMOVES
// it) has exactly one implementation. Takes `favorited` explicitly rather than reading `result.data
// .favorited` so a caller applying the same target across a whole selection (setFavoritedItems)
// never has to reconstruct it from the item.
function applyFavoritePatch(favorited: boolean, result: DriveItem): void {
	driveListingQueryUpdateGlobal(prev => replaceIfPresent(prev, result))

	// Favorites is its own membership listing, not merely a flag on an existing row: favoriting must
	// be able to ADD a row that listing never had, unfavoriting must REMOVE it — the global flag patch
	// above only ever updates rows that already exist. The add path dedups on uuid alone rather than
	// upsertDriveItem's name-collision rule: favorites aggregates across every directory, so two
	// distinct items from different parents can legitimately share a name, and every other upsert call
	// site targets a single drive-parent where the backend already enforces name-uniqueness.
	queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "favorites", uuid: null }), prev =>
		prev === undefined ? prev : favorited ? [...removeByUuid(prev, result.data.uuid), result] : removeByUuid(prev, result.data.uuid)
	)
}

export async function toggleFavorite(item: DriveItem): Promise<ActionOutcome> {
	const nextFavorited = !item.data.favorited

	let result: DriveItem
	try {
		result = narrowItem(await runOp<Dir | File>(sdkApi.setFavorited(item.data, nextFavorited)))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	applyFavoritePatch(nextFavorited, result)

	return { status: "success", item: result }
}

// Bulk favorite is a SET, not a per-item toggle (mobile parity — see driveSelectors.ts/
// headerMenuBuilders.ts's buildBulkActionMenu): the bulk-action bar computes one target
// (`!flags.includesFavorited`) from the whole selection and applies it to every item, rather than
// each item flipping its own current flag independently.
export function setFavoritedItems(items: DriveItem[], favorited: boolean): Promise<BulkOutcome<DriveItem>> {
	return runBulk(items, async item => {
		const result = narrowItem(await runOp<Dir | File>(sdkApi.setFavorited(item.data, favorited)))
		applyFavoritePatch(favorited, result)
	})
}

// ── Color ────────────────────────────────────────────────────────────────

export async function setColor(dir: DirectoryItem, color: DirColor): Promise<ActionOutcome> {
	let colored: Dir
	try {
		colored = await runOp(sdkApi.setDirectoryColor(dir.data, color))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const updated = narrowItem(colored)
	driveListingQueryUpdateGlobal(prev => replaceIfPresent(prev, updated))

	return { status: "success", item: updated }
}

// ── File versions ────────────────────────────────────────────────────────

export async function restoreVersion(file: FileItem, version: FileVersion): Promise<ActionOutcome> {
	let restored: File
	try {
		restored = await runOp(sdkApi.restoreFileVersionOp(file.data, version))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// Content change, not a move: the returned file carries a ROTATED uuid, replacing the old one in
	// the SAME listing. upsertDriveItem's own dedup can't be relied on alone — an undecryptable row
	// has no name to match against — so the stale uuid is dropped explicitly as well.
	const updated = narrowItem(restored)
	const oldUuid = file.data.uuid
	driveListingQueryUpdate(normalizeParentUuid(file.data.parent, currentRootUuid()), prev =>
		removeByUuid(upsertDriveItem(prev, updated), oldUuid)
	)

	return { status: "success", item: updated }
}

// deleteFileVersionOp takes only the version and deletes by ITS uuid alone — for every version
// except the live one that's just history, but the live version's uuid IS the file's own current
// storage blob (see restoreVersion/isCurrentVersion), so deleting it would destroy the file's
// current content, not just a historical entry. The versions panel already disables this per row;
// this guard is the same rule enforced again at the library boundary so no future caller can reach
// the live-blob delete by skipping the UI (defense-in-depth).
export async function deleteVersion(file: FileItem, version: FileVersion): Promise<VoidActionOutcome> {
	if (version.uuid === file.data.uuid) {
		const message = i18n.t("drive:driveVersionsDeleteLiveBlocked")
		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	try {
		await runOp(sdkApi.deleteFileVersionOp(version))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
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
	let link: DriveItemLinkStatus

	try {
		link =
			item.type === "directory"
				? { type: "directory", status: await runOp(sdkApi.createDirectoryLink(item.data, Comlink.proxy(onProgress))) }
				: { type: "file", status: await runOp(sdkApi.createFileLink(item.data)) }
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	driveItemLinkStatusQueryUpdate(item.data.uuid, link)

	return { status: "success", link }
}

// `next` carries the merged object (see link-dialog.logic.ts's buildLinkUpdate) — the item/link type
// pairing is re-verified here rather than trusted blindly, since the two are independently-typed
// parameters the type system can't itself correlate.
export async function updateLink(item: DriveItem, next: DriveItemLinkStatus): Promise<LinkActionOutcome> {
	let link: DriveItemLinkStatus

	try {
		if (item.type === "directory" && next.type === "directory") {
			link = { type: "directory", status: await runOp(sdkApi.updateDirectoryLink(item.data, next.status)) }
		} else if (item.type === "file" && next.type === "file") {
			link = { type: "file", status: await runOp(sdkApi.updateFileLink(item.data, next.status)) }
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
// link object, so the caller's already-fetched status is threaded through as `current`.
export async function disableLink(item: DriveItem, current: DriveItemLinkStatus): Promise<VoidActionOutcome> {
	try {
		if (item.type === "directory" && current.type === "directory") {
			await runOp(sdkApi.removeDirectoryLink(item.data))
		} else if (item.type === "file" && current.type === "file") {
			await runOp(sdkApi.removeFileLink(item.data, current.status))
		} else {
			throw new Error("Item/link type mismatch")
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	driveItemLinkStatusQueryUpdate(item.data.uuid, null)

	return { status: "success" }
}
