import { useRecyclingState } from "@shopify/flash-list"
import { useEffect } from "react"
import { useShallow } from "zustand/shallow"
import { AnyDirWithContext } from "@filen/sdk-rs"
import { getRealDriveItemParent, unwrapDirMeta, unwrappedDirIntoDriveItem, unwrapParentUuid } from "@/lib/sdkUnwrap"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import cache from "@/lib/cache"
import auth from "@/lib/auth"
import events from "@/lib/events"
import logger from "@/lib/logger"
import type { DriveItemFileExtracted } from "@/types"

export type EditableTarget = {
	/** The file to write back to — the freshly uploaded one once a save has happened, else the original. */
	itemToUse: DriveItemFileExtracted | null
	parent: AnyDirWithContext | "sharedInRoot" | null
	/** True when this preview must not offer to write anything back. */
	readOnly: boolean
	/** Records the replacement produced by a save, and republishes the rotated identity. */
	applySaved: (newItem: DriveItemFileExtracted) => void
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
	// Parent directory resolved by the background warm below for a cross-directory search hit whose
	// parent isn't cached. Preferred over reading the cache directly so `readOnly` recomputes the
	// moment the warm lands — the React Compiler memoizes `parent`, and getRealDriveItemParent reads a
	// non-reactive Map.
	const [warmedParent, setWarmedParent] = useRecyclingState<AnyDirWithContext | null>(null, [galleryItemKey(item)])

	const parent =
		warmedParent ??
		(item.type === "drive" && drivePath
			? getRealDriveItemParent({
					item: item.data,
					drivePath
				})
			: null)

	// Warm the parent-directory cache for a deep search result: editability needs the parent dir in
	// cache, and a file opened from a directory listing already has it while a search hit may not.
	useEffect(() => {
		// Only the plain-drive `file` case: shared files resolve their parent from a different cache,
		// and only `file` carries a parent uuid.
		if (item.type !== "drive" || item.data.type !== "file") {
			return
		}

		const parentUuid = unwrapParentUuid(item.data.data.parent)

		// A root parent resolves without the cache, and an already-cached parent needs no warm.
		if (!parentUuid || (cache.rootUuid && parentUuid === cache.rootUuid) || cache.directoryUuidToAnyNormalDir.get(parentUuid)) {
			return
		}

		const controller = new AbortController()

		;(async () => {
			try {
				const { authedSdkClient } = await auth.getSdkClients()
				const dir = await authedSdkClient.getDirOptional(parentUuid, {
					signal: controller.signal
				})

				if (!dir || controller.signal.aborted) {
					return
				}

				const dirItem = unwrappedDirIntoDriveItem(unwrapDirMeta(dir))

				cache.cacheNewNormalDir(dir, dirItem)

				const normalDir = cache.directoryUuidToAnyNormalDir.get(parentUuid)

				if (normalDir && !controller.signal.aborted) {
					setWarmedParent(new AnyDirWithContext.Normal(normalDir))
				}
			} catch (e) {
				logger.warn("drivePreview", "Failed to warm parent directory for preview", {
					error: e
				})
			}
		})()

		return () => {
			controller.abort()
		}
	}, [item, setWarmedParent])

	const itemToUse =
		item.type === "drive"
			? itemEdited &&
				itemEdited.data.decryptedMeta?.name.toLowerCase().trim() === item.data.data.decryptedMeta?.name.toLowerCase().trim()
				? itemEdited
				: item.data
			: null

	const readOnly =
		!itemToUse || item.type !== "drive"
			? true
			: itemToUse.type !== "file" || !itemToUse.data.decryptedMeta || !parent || parent === "sharedInRoot"

	return {
		itemToUse,
		parent,
		readOnly,
		applySaved: (newItem: DriveItemFileExtracted) => {
			// An upload rotates the uuid because the content changed. The new item is already cached by
			// uploadCore; drop the stale entry and announce the rotation so the list, preview and search
			// re-key rather than holding a uuid that no longer exists.
			const oldUuid = itemToUse?.data.uuid

			setItemEdited(newItem)

			useDrivePreviewStore.getState().setCurrentItem({
				type: "drive",
				data: newItem
			})

			if (!oldUuid) {
				return
			}

			if (oldUuid !== newItem.data.uuid) {
				cache.forgetItem(oldUuid)
			}

			events.emit("driveItemUpdated", {
				previousUuid: oldUuid,
				item: newItem,
				// The preview produced this change, so it must not reload from it — itemToUse already
				// points at the replacement for the next save.
				reseedPreview: false
			})
		}
	}
}
