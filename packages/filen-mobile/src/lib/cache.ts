import {
	AnyNormalDir,
	AnySharedDir,
	AnySharedDirWithContext,
	AnyLinkedDir,
	type SharedDir,
	type SharingRole,
	type SharedRootDirsAndFiles,
	type LinkedDirsAndFiles,
	type File,
	type DirPublicLink,
	type Dir
} from "@filen/sdk-rs"
import { type DriveItem } from "@/types"

/**
 * Session-scoped in-memory uuid caches for the drive layer: uuid → DriveItem plus the type-derived
 * SDK views (normal / shared-with-context / linked) downstream code reads. Every map is a plain Map
 * rebuilt per process — by fetches, optimistic mutations, and the boot warm-seed from the restored
 * listing queries — and is NEVER mirrored to SQLite (decrypted metadata stays in memory only).
 *
 * Durable state lives with its owning feature, not here: the camera-upload ledger in
 * cameraUploadState, thumbnails on disk, listings in the query persister.
 */
export class Cache {
	// Dropped on app restart.
	public rootUuid: string | null = null

	// Managed separately by secureStore.ts with its own encryption.
	public readonly secureStore = new Map<string, unknown>()

	// uuid indexes — rebuilt per process by fetches, mutations, and the boot warm-seed.
	public readonly uuidToAnyDriveItem = new Map<string, DriveItem>()
	public readonly fileUuidToNormalFile = new Map<string, File>()
	public readonly directoryUuidToAnySharedDirWithContext = new Map<string, AnySharedDirWithContext>()
	public readonly directoryUuidToAnyNormalDir = new Map<string, AnyNormalDir>()
	public readonly directoryUuidToAnyLinkedDirWithMeta = new Map<
		string,
		{
			dir: AnyLinkedDir
			meta: DirPublicLink
		}
	>()
	public readonly chatAttachmentLayouts = new Map<
		string,
		{
			width: number
			height: number
		}
	>()

	/**
	 * Mirror a newly-known file into every cache that downstream
	 * code reads from. Call after any optimistic `driveItemsQueryUpdate()` that
	 * adds a file (upload completion, socket FileNew/FileRestore/FileArchiveRestored,
	 * move-to-destination, etc.). The reference implementation that this mirrors
	 * lives inline in `src/queries/useDriveItems.query.ts:fetchData()`.
	 */
	//
	// The `driveItem` params below are typed as the full DriveItem union (not the narrowed
	// Extract<>) so fetchData — whose unwrap builders return the union — can call these without
	// a per-branch narrowing cast; the strongly-typed RAW SDK param (file/dir) is what drives
	// the derived-cache construction, so correctness is preserved.
	public cacheNewFile(file: File, driveItem: DriveItem): void {
		this.uuidToAnyDriveItem.set(file.uuid, driveItem)
		this.fileUuidToNormalFile.set(file.uuid, file)
	}

	/**
	 * Mirror a newly-known (own / non-shared) directory into every
	 * cache. Use after any optimistic add of a directory to the TanStack listing
	 * (createDirectory, socket FolderSubCreated/FolderRestore, move-to-destination).
	 */
	public cacheNewNormalDir(dir: Dir, driveItem: DriveItem): void {
		this.uuidToAnyDriveItem.set(dir.uuid, driveItem)
		this.directoryUuidToAnyNormalDir.set(dir.uuid, new AnyNormalDir.Dir(dir))
	}

	/**
	 * Mirror a newly-known SHARED (non-root) directory into every cache.
	 * Reference implementation: the "shared" branch of useDriveItems.query.ts fetchData().
	 * `sharedOut` mirrors fetchData: a directory you share OUT is your own, so it ALSO has a
	 * valid normal-dir view (cached under directoryUuidToAnyNormalDir); a directory shared IN
	 * (someone else's) has no normal-dir view and is not.
	 */
	public cacheNewSharedDir(
		dir: SharedDir & { sharingRole: SharingRole },
		driveItem: DriveItem,
		opts: { sharedOut: boolean }
	): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		this.directoryUuidToAnySharedDirWithContext.set(
			uuid,
			AnySharedDirWithContext.new({
				dir: new AnySharedDir.Dir(dir),
				shareInfo: dir.sharingRole
			})
		)

		if (opts.sharedOut) {
			this.directoryUuidToAnyNormalDir.set(uuid, new AnyNormalDir.Dir(dir.inner))
		}
	}

	/**
	 * Mirror a newly-known SHARED ROOT directory (top-level shared-in/out entry) into every
	 * cache. Reference: the "sharedRoot" branch of fetchData().
	 */
	public cacheNewSharedRootDir(dir: SharedRootDirsAndFiles["dirs"][number], driveItem: DriveItem): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		this.directoryUuidToAnySharedDirWithContext.set(
			uuid,
			AnySharedDirWithContext.new({
				dir: new AnySharedDir.Root(dir),
				shareInfo: dir.sharingRole
			})
		)
	}

	/**
	 * Mirror a newly-known SHARED file into the caches. Reference: the "shared" branch of
	 * fetchData(). A file you share OUT is also cached as a normal File (own file, sharingRole
	 * stripped); a file shared IN is referenced by uuid only.
	 */
	public cacheNewSharedFile(
		file: File & { sharingRole: SharingRole },
		driveItem: DriveItem,
		opts: { sharedOut: boolean }
	): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		if (opts.sharedOut) {
			const { sharingRole: _, ...normalFile } = file

			this.fileUuidToNormalFile.set(uuid, normalFile)
		}
	}

	/**
	 * Mirror a newly-known LINKED directory (public-link browse) into the caches. Reference:
	 * the "linked" branch of fetchData(). The uuid→item mapping is always seeded; the linked-meta
	 * cache (which needs the parent link's meta, not carried on the DriveItem) is seeded only when
	 * `meta` is known — matching fetchData, which caches those under `if (meta)`.
	 */
	public cacheNewLinkedDir(dir: LinkedDirsAndFiles["dirs"][number], driveItem: DriveItem, meta: DirPublicLink | null): void {
		const uuid = driveItem.data.uuid

		this.uuidToAnyDriveItem.set(uuid, driveItem)

		if (!meta) {
			return
		}

		this.directoryUuidToAnyLinkedDirWithMeta.set(uuid, {
			dir: new AnyLinkedDir.Dir(dir),
			meta
		})
	}

	/**
	 * Reference an item by uuid only (uuidToAnyDriveItem), with no derived-cache seeding.
	 * Mirrors the "offline", shared-root-file and linked-file branches of fetchData(), which
	 * cache only the uuid→item mapping.
	 */
	public cacheDriveItemReference(driveItem: DriveItem): void {
		this.uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)
	}

	/**
	 * Seed every cache that can be derived from a DriveItem ALONE, dispatching on the item's own type
	 * discriminator (item.data IS the SDK type each helper needs). Used by the drive optimistic path and
	 * the boot warm-seed so a listing mutation reseeds the type-derived caches too, not just
	 * uuidToAnyDriveItem, without a refetch. Context the item can't carry is handled conservatively:
	 *   - the sharedOut refinement (a `sharedDirectory` ALSO getting the normal-dir view) is taken from
	 *     `opts.sharedOut` — the caller knows the listing's context (default false); a shared FILE stays
	 *     shared-in (its raw-size normal view can't be rebuilt from a DriveItem);
	 *   - a `directory` item is always treated as normal (linked browse is read-only — never
	 *     optimistically updated — and the linked caches need the parent link meta, not on the item);
	 *   - a shared item whose optional sharingRole didn't survive onto the DriveItem falls back to a
	 *     uuid-only reference instead of building a share context with a missing role.
	 */
	public cacheDriveItem(item: DriveItem, opts?: { sharedOut?: boolean }): void {
		switch (item.type) {
			case "file": {
				this.cacheNewFile(item.data, item)

				break
			}

			case "directory": {
				this.cacheNewNormalDir(item.data, item)

				break
			}

			case "sharedDirectory": {
				if (item.data.sharingRole) {
					this.cacheNewSharedDir({ ...item.data, sharingRole: item.data.sharingRole }, item, {
						sharedOut: opts?.sharedOut ?? false
					})
				} else {
					this.cacheDriveItemReference(item)
				}

				break
			}

			case "sharedRootDirectory": {
				this.cacheNewSharedRootDir(item.data, item)

				break
			}

			case "sharedFile": {
				this.cacheNewSharedFile(item.data, item, { sharedOut: false })

				break
			}

			case "sharedRootFile": {
				this.cacheDriveItemReference(item)

				break
			}
		}
	}

	/**
	 * Forget every cache entry for a uuid. Use after a permanent
	 * delete (FileDeletedPermanent / FolderDeletedPermanent, deletePermanently,
	 * emptyTrash). Do NOT use for trash/archive — the item still exists, just
	 * lives in a different listing.
	 */
	public forgetItem(uuid: string): void {
		this.uuidToAnyDriveItem.delete(uuid)
		this.fileUuidToNormalFile.delete(uuid)
		this.directoryUuidToAnyNormalDir.delete(uuid)
		this.directoryUuidToAnySharedDirWithContext.delete(uuid)
		this.directoryUuidToAnyLinkedDirWithMeta.delete(uuid)
	}

	// Drop the session-scoped decrypted metadata from memory (logout). Durable state is wiped by
	// its owning feature; the kv rows themselves die in the SQLite DELETE FROM kv.
	public clear(): void {
		this.secureStore.clear()
		this.rootUuid = null

		this.uuidToAnyDriveItem.clear()
		this.fileUuidToNormalFile.clear()
		this.directoryUuidToAnySharedDirWithContext.clear()
		this.directoryUuidToAnyNormalDir.clear()
		this.directoryUuidToAnyLinkedDirWithMeta.clear()
		this.chatAttachmentLayouts.clear()
	}
}

const cache = new Cache()

export default cache
