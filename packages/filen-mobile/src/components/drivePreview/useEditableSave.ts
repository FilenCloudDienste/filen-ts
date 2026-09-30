import { useEffect, useRef } from "react"
import { useRecyclingState } from "@shopify/flash-list"
import { AnyDirWithContext_Tags } from "@filen/sdk-rs"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import useEditableTarget from "@/components/drivePreview/useEditableTarget"
import useRemoteRevisions from "@/components/drivePreview/useRemoteRevisions"
import { unwrapFileMeta, unwrappedFileIntoDriveItem, unwrapParentUuid } from "@/lib/sdkUnwrap"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import transfers from "@/features/transfers/transfers"
import useIsOnline from "@/hooks/useIsOnline"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import type { File } from "expo-file-system"
import type { DriveItemFileExtracted } from "@/types"

/**
 * The save flow of an editable preview (text/code, PDF): writes the editor's content back over its file, asks
 * first about a version saved elsewhere, and publishes the dirty flag and a save handle for the route-level
 * unsaved-changes guard. One copy, because it decides which version of a file is overwritten.
 */
export default function useEditableSave(
	item: GalleryItemTagged,
	messages: {
		// Logged when an upload fails.
		failed: string
		// Thrown, and shown, when the editor could not serialise its content.
		notSerialised: string
	}
) {
	const isOnline = useIsOnline()
	const { itemToUse, resolveParent, readOnly, applySaved } = useEditableTarget(item)
	const [hasEdits, setHasEdits] = useRecyclingState<boolean>(false, [galleryItemKey(item)])
	const saveHandleRef = useRef<(() => Promise<File | null>) | null>(null)
	const savingRef = useRef<boolean>(false)
	// False once this editor unmounted: a save still in its check then uploads nothing.
	const mountedRef = useRef<boolean>(true)

	useEffect(() => {
		mountedRef.current = true

		return () => {
			mountedRef.current = false
		}
	}, [])

	const save = async (): Promise<boolean> => {
		// Synchronous, because the loading overlay is not: it mounts a commit and a native present
		// later, so a double tap — or the unsaved-changes prompt, which floats ABOVE the overlay —
		// can enter twice. Two concurrent saves share one write target, and a chunk still in flight
		// from the first lands in the second's file: a PDF still begins with %PDF-, so it passes
		// validation and a spliced document replaces the user's file.
		if (savingRef.current || !hasEdits || readOnly || !isOnline) {
			return false
		}

		savingRef.current = true

		let saved: DriveItemFileExtracted | null = null

		try {
			// A version saved elsewhere while the socket was down is asked about before this save goes over it.
			// The check may read the file's directory: the loading state shows meanwhile.
			const checked = await runWithLoading(async () => await remote.beforeSave())
			const target = checked.success ? checked.data : null

			// Discarded or closed during the check: nothing to save into.
			if (target === null || !mountedRef.current) {
				return false
			}

			const result = await runSave(target)

			saved = result.saved

			return result.ok
		} finally {
			savingRef.current = false
			// Judged with the save slot released, so a check the save held back runs now.
			remote.saveSettled(saved)
		}
	}

	// Uploads the editor's content under `name` beside the file: the file's own name makes a new version
	// of it, any other a new file.
	const uploadEdits = async (name: string, target: DriveItemFileExtracted | null = itemToUse) =>
		await runWithLoading(async defer => {
			if (!target?.data.decryptedMeta) {
				throw new Error("Missing decryptedMeta")
			}

			// The target's own directory: it may have moved elsewhere, found by the check before this save.
			const parent = await resolveParent(target.type === "file" ? (unwrapParentUuid(target.data.parent) ?? undefined) : undefined)

			if (!parent || parent === "sharedInRoot" || parent.tag !== AnyDirWithContext_Tags.Normal) {
				throw new Error("Missing parent directory")
			}

			// Serialised by the editor into a temp file — the content never crosses the bridge whole.
			const savedFile = await saveHandleRef.current?.()

			if (!savedFile) {
				throw new Error(messages.notSerialised)
			}

			defer(() => {
				if (savedFile.exists) {
					savedFile.delete()
				}
			})

			return await transfers.upload({
				localFileOrDir: savedFile,
				parent: parent.inner[0],
				name,
				modified: Date.now(),
				created: target.data.decryptedMeta.created != null ? Number(target.data.decryptedMeta.created) : undefined,
				mime: target.data.decryptedMeta.mime
			})
		})

	// Writes the edits over `target`, under its name: what the save made, when it made a file.
	const runSave = async (target: DriveItemFileExtracted): Promise<{ ok: boolean; saved: DriveItemFileExtracted | null }> => {
		const name = target.data.decryptedMeta?.name

		if (name === undefined) {
			return { ok: false, saved: null }
		}

		const result = await uploadEdits(name, target)

		if (!result.success) {
			logger.error("drivePreview", messages.failed, {
				error: result.error
			})

			alerts.error(result.error)

			return { ok: false, saved: null }
		}

		if (!result.data) {
			return { ok: false, saved: null }
		}

		setHasEdits(false)

		const newFile = result.data.files[0]
		const newDriveItem = newFile ? unwrappedFileIntoDriveItem(unwrapFileMeta(newFile)) : null

		if (newDriveItem?.type !== "file") {
			return { ok: true, saved: null }
		}

		applySaved(newDriveItem)

		return { ok: true, saved: newDriveItem }
	}

	// The unsaved edits written to a new file beside this one, for the remote-change prompts.
	const saveAsNewFile = async (name: string): Promise<DriveItemFileExtracted | null> => {
		const result = await uploadEdits(name)

		if (!result.success) {
			logger.error("drivePreview", messages.failed, {
				error: result.error
			})

			alerts.error(result.error)

			return null
		}

		const newFile = result.data?.files[0]
		const newDriveItem = newFile ? unwrappedFileIntoDriveItem(unwrapFileMeta(newFile)) : null

		if (newDriveItem?.type !== "file") {
			return null
		}

		setHasEdits(false)

		return newDriveItem
	}

	const remote = useRemoteRevisions({ item, itemToUse, resolveParent, hasEdits, savingRef, saveAsNewFile })

	// Publish the dirty flag so the route-level unsaved-changes guard can prompt on navigate-away.
	useEffect(() => {
		useDrivePreviewStore.getState().setHasUnsavedEdits(hasEdits && !readOnly)
	}, [hasEdits, readOnly])

	// save() is re-created each render; publish ONE stable wrapper so the guard can save-then-leave,
	// and clear it on unmount so a later preview cannot inherit this item's dirty state.
	const saveRef = useRef(save)

	useEffect(() => {
		saveRef.current = save
	})

	useEffect(() => {
		useDrivePreviewStore.getState().setSaveEdits(() => saveRef.current())

		return () => {
			useDrivePreviewStore.getState().setSaveEdits(null)
			useDrivePreviewStore.getState().setHasUnsavedEdits(false)
		}
	}, [])

	return { hasEdits, setHasEdits, saveHandleRef, readOnly, save, isOnline }
}
