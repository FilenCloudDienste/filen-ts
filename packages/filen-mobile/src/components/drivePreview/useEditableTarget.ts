import { useRecyclingState } from "@shopify/flash-list"
import { useEffect } from "react"
import { useShallow } from "zustand/shallow"
import { AnyDirWithContext } from "@filen/sdk-rs"
import { getRealDriveItemParent, unwrapDirMeta, unwrappedDirIntoDriveItem, unwrapParentUuid } from "@/lib/sdkUnwrap"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import { galleryItemFollowing } from "@/components/drivePreview/galleryRenderName"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { onSocketReconnected } from "@/stores/useSocket.store"
import cache from "@/lib/cache"
import auth from "@/lib/auth"
import events from "@/lib/events"
import logger from "@/lib/logger"
import type { DriveItemFileExtracted } from "@/types"

type Parent = AnyDirWithContext | "sharedInRoot" | null

export type EditableTarget = {
	/** The file to write back to — the freshly uploaded one once a save has happened, else the original. */
	itemToUse: DriveItemFileExtracted | null
	/** The directory to write into, null while an own file's directory is not yet known (resolveParent). */
	parent: Parent
	/** The directory to write into, looked up now when it is not yet known. */
	resolveParent: () => Promise<Parent>
	/** True when this preview must not offer to write anything back. */
	readOnly: boolean
	/** Records the replacement produced by a save, and republishes the rotated identity. */
	applySaved: (newItem: DriveItemFileExtracted) => void
}

// Looks an own directory up by uuid and caches it: a file opened from a directory listing has its parent
// cached, a search hit or a file moved elsewhere into an unlisted directory may not.
async function warmParent(parentUuid: string, signal?: AbortSignal): Promise<AnyDirWithContext | null> {
	const { authedSdkClient } = await auth.getSdkClients()
	const dir = await authedSdkClient.getDirOptional(parentUuid, signal ? { signal } : undefined)

	if (!dir || signal?.aborted) {
		return null
	}

	cache.cacheNewNormalDir(dir, unwrappedDirIntoDriveItem(unwrapDirMeta(dir)))

	const normalDir = cache.directoryUuidToAnyNormalDir.get(parentUuid)

	return normalDir ? new AnyDirWithContext.Normal(normalDir) : null
}

/**
 * Resolves whether a previewed file can be written back, and where to.
 *
 * Shared by the text/code and PDF previews: both need the same parent lookup, the same read-only
 * rule, and the same bookkeeping after an upload rotates the file's uuid. Two copies of this would
 * drift on exactly the question of which files are editable.
 */
export default function useEditableTarget(item: GalleryItemTagged): EditableTarget {
	const drivePath = useDrivePreviewStore(useShallow(state => state.drivePath))
	const [itemEdited, setItemEdited] = useRecyclingState<DriveItemFileExtracted | null>(null, [galleryItemKey(item)])
	// Parent directory resolved by the warm below. Preferred over reading the cache directly so `parent`
	// recomputes the moment the warm lands — the React Compiler memoizes it, and getRealDriveItemParent
	// reads a non-reactive Map. Kept with the uuid it is for: a move elsewhere changes the file's parent
	// under the same key.
	const [warmedParent, setWarmedParent] = useRecyclingState<{ uuid: string; dir: AnyDirWithContext } | null>(null, [galleryItemKey(item)])
	// The directory of a file of the user's own drive, the only kind whose directory can be looked up and
	// written into. A file listed through a public link or a share carries no stable id, and its parent lives
	// in another cache: it stays read-only, and is never looked up.
	const ownFile = item.type === "drive" && item.data.type === "file" ? item.data : null
	const parentUuid =
		ownFile !== null && ownFile.data.stableUuid !== undefined && drivePath?.type !== "linked" && drivePath?.type !== "sharedIn"
			? unwrapParentUuid(ownFile.data.parent)
			: null
	const ownParentUuid = parentUuid !== null && !cache.directoryUuidToAnyLinkedDirWithMeta.has(parentUuid) ? parentUuid : null

	const parent =
		(warmedParent !== null && warmedParent.uuid === ownParentUuid ? warmedParent.dir : null) ??
		(item.type === "drive" && drivePath
			? getRealDriveItemParent({
					item: item.data,
					drivePath
				})
			: null)

	// Warm the parent-directory cache for an own file whose directory is not cached (a deep search hit, a
	// move elsewhere into a directory not listed yet), again after a socket gap if it failed.
	useEffect(() => {
		const uuid = ownParentUuid

		if (ownFile === null || uuid === null) {
			return
		}

		// The drive socket patches a rename or move of a cached file only: a search hit is cached here, so
		// this preview follows one made elsewhere (driveItemUpdated).
		if (!cache.fileUuidToNormalFile.get(ownFile.data.uuid)) {
			cache.cacheDriveItem(ownFile)
		}

		// A root parent resolves without the cache, and an already-cached parent needs no warm.
		const needed = () => !(cache.rootUuid && uuid === cache.rootUuid) && !cache.directoryUuidToAnyNormalDir.get(uuid)

		if (!needed()) {
			return
		}

		const controller = new AbortController()

		const warm = () => {
			warmParent(uuid, controller.signal)
				.then(dir => {
					if (dir && !controller.signal.aborted) {
						setWarmedParent({ uuid, dir })
					}
				})
				.catch((e: unknown) => {
					logger.warn("drivePreview", "Failed to warm parent directory for preview", {
						error: e
					})
				})
		}

		warm()

		const unsubscribeReconnected = onSocketReconnected(() => {
			if (needed()) {
				warm()
			}
		})

		return () => {
			controller.abort()
			unsubscribeReconnected()
		}
	}, [ownFile, ownParentUuid, setWarmedParent])

	// The saved version until the gallery shows it; from then on the gallery's item, which follows a rename
	// or move made elsewhere.
	const itemToUse =
		item.type === "drive"
			? itemEdited &&
				itemEdited.data.uuid !== item.data.data.uuid &&
				itemEdited.data.decryptedMeta?.name.toLowerCase().trim() === item.data.data.decryptedMeta?.name.toLowerCase().trim()
				? itemEdited
				: item.data
			: null

	// An own file stays writable while its directory is being looked up: read-only there would also disarm
	// the unsaved-edits guard over edits already typed. The save resolves the directory itself.
	const readOnly =
		!itemToUse || item.type !== "drive"
			? true
			: itemToUse.type !== "file" ||
				!itemToUse.data.decryptedMeta ||
				(parent === null ? ownParentUuid === null : parent === "sharedInRoot")

	return {
		itemToUse,
		parent,
		resolveParent: async () => {
			if (parent !== null || ownParentUuid === null) {
				return parent
			}

			const dir = await warmParent(ownParentUuid)

			if (dir) {
				setWarmedParent({ uuid: ownParentUuid, dir })
			}

			return dir
		},
		readOnly,
		applySaved: (newItem: DriveItemFileExtracted) => {
			// An upload rotates the uuid because the content changed. The new item is already cached by
			// uploadCore; drop the stale entry and announce the rotation so the list, preview and search
			// re-key rather than holding a uuid that no longer exists.
			const oldUuid = itemToUse?.data.uuid

			setItemEdited(newItem)

			useDrivePreviewStore.getState().setCurrentItem(galleryItemFollowing(item, newItem))

			if (!oldUuid) {
				return
			}

			if (oldUuid !== newItem.data.uuid) {
				cache.forgetItem(oldUuid)
			}

			// The preview reloads from this, because it must: the file's identity has moved and the
			// uuid-keyed file queries the preview is built on have to follow it. Suppressing the reload
			// was tried and does not work — the gallery's own file query re-keys either way, so the
			// editor is torn down regardless, and holding the pre-save item made later operations on the
			// file (a move, a trash) address a uuid the server no longer has.
			events.emit("driveItemUpdated", {
				previousUuid: oldUuid,
				item: newItem
			})
		}
	}
}
