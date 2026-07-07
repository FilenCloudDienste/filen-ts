import type { Dir, DirColor, File, FileVersion, UserInfo } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { driveListingQueryKey, driveListingQueryUpdate, driveListingQueryUpdateGlobal, normalizeParentUuid } from "@/queries/drive"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/lib/drive/item"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { runBulk, type BulkOutcome } from "@/lib/drive/bulk"

export type DirectoryItem = Extract<DriveItem, { type: "directory" }>
export type FileItem = Extract<DriveItem, { type: "file" }>

export type ActionOutcome = { status: "success"; item: DriveItem } | { status: "error"; dto: ErrorDTO }

export type VoidActionOutcome = { status: "success" } | { status: "error"; dto: ErrorDTO }

// Every worker call funnels through here so a rejection — whichever side ends up catching it, a
// singular action's own try/catch or runBulk's per-item catch — is already LABEL-FIRST-shaped.
// asErrorDTO is idempotent on a DTO the worker's Comlink boundary already threw and normalizes
// anything else (e.g. a plain Error from a mocked op in tests), so this is safe to apply uniformly.
// A directory-vs-file ternary (two differently-typed remote calls) or a remote method whose own
// resolved type is itself a union both need an explicit `runOp<Dir | File>(...)` at the call site —
// Comlink's Remote<T> wraps a return type through two DISTRIBUTIVE conditional types, which turns a
// union return into a union of Promises rather than a Promise of a union, defeating T's inference.
async function runOp<T>(op: Promise<T>): Promise<T> {
	try {
		return await op
	} catch (e) {
		// A plain ErrorDTO thrown intact is what the singular actions' own try/catch and runBulk's
		// per-item catch both expect to receive; an Error subclass would just need unwrapping right
		// back out again.
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate, see above
		throw asErrorDTO(e)
	}
}

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
	driveListingQueryUpdate(normalizeParentUuid(item.data.parent, currentRootUuid()), prev => upsertDriveItem(prev, updated))
	// Breadcrumb name cache — this item's uuid may appear as an ancestor segment on some open path.
	await queryClient.invalidateQueries({ queryKey: ["drive", "names"] })

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

export async function toggleFavorite(item: DriveItem): Promise<ActionOutcome> {
	const nextFavorited = !item.data.favorited

	let result: DriveItem
	try {
		result = narrowItem(await runOp<Dir | File>(sdkApi.setFavorited(item.data, nextFavorited)))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	driveListingQueryUpdateGlobal(prev => replaceIfPresent(prev, result))

	// Favorites is its own membership listing, not merely a flag on an existing row: favoriting must
	// be able to ADD a row that listing never had, unfavoriting must REMOVE it — the global flag patch
	// above only ever updates rows that already exist.
	queryClient.setQueryData<DriveItem[]>(driveListingQueryKey({ variant: "favorites", uuid: null }), prev =>
		prev === undefined ? prev : nextFavorited ? upsertDriveItem(prev, result) : removeByUuid(prev, result.data.uuid)
	)

	return { status: "success", item: result }
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

// `file` is unused: deleteFileVersionOp takes only the version (the file has no listing-cache effect
// to patch here) — kept as a parameter for call-site symmetry with restoreVersion.
export async function deleteVersion(_file: FileItem, version: FileVersion): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.deleteFileVersionOp(version))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
}
