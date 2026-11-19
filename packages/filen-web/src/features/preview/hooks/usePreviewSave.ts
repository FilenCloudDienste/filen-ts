import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { DriveItem } from "@/features/drive/lib/item"
import {
	isUnresolvableParentError,
	presentationSaveRefusalKey,
	runPreviewSave,
	SaveRefusedError,
	settledStorageRefusal,
	type PresentationSaveEdits
} from "@/features/drive/lib/previewSave.logic"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { splicePhotoSave } from "@/features/photos/queries/photos"
import { editedCopySuffix } from "@/features/preview/components/previewOverlay.logic"
import type { usePreviewRemoteChanges } from "@/features/preview/hooks/usePreviewRemoteChanges"
import type { ImageEditState } from "@/features/preview/imageEdit/editSession"
import type { ImageExportSource, SaveTarget } from "@/features/preview/imageEdit/types"
import { seedSavedImage, writeImageCopy, writeImageInPlace } from "@/features/preview/lib/imageSave"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"
import { loadPreviewBytes } from "@/features/preview/lib/previewCache"
import type { TextBuffer } from "@/features/preview/lib/textFile"
import { dropPreviewBuffer } from "@/features/preview/store/usePreviewUnsavedGuard"
import type { VideoEditorCommands } from "@/features/preview/videoEdit/components/videoEditor"
import type { VideoEditState } from "@/features/preview/videoEdit/useVideoEditMode"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { sdkApi } from "@/lib/sdk/client"
import { useLatestRef } from "@/lib/useLatestRef"

// What a save uploads (PreviewOverlay's readSaveEdits).
export type PreviewSaveEdits = { bytes: Uint8Array; commit: (() => void) | null; encoding?: string } | PresentationSaveEdits

interface UsePreviewSaveParams {
	cacheScope: string | null
	driveItem: DriveItem | undefined
	rawDriveItem: DriveItem | undefined
	editable: boolean
	dirty: boolean
	saving: boolean
	setSaving: Dispatch<SetStateAction<boolean>>
	saveBlocked: boolean
	anyEditing: boolean
	editing: ImageEditState | null
	imagePrimaryTarget: SaveTarget | null
	videoEditing: VideoEditState | null
	videoCommandsRef: RefObject<VideoEditorCommands | null>
	imageSaveRef: RefObject<ImageExportSource | null>
	contentRef: RefObject<TextBuffer | null>
	mountedRef: RefObject<boolean>
	currentSlotRef: RefObject<string | null>
	remote: ReturnType<typeof usePreviewRemoteChanges>
	readSaveEdits: (auto: boolean, explain: boolean) => Promise<PreviewSaveEdits | null>
	commitSaved: (frozenUuid: string, item: DriveItem, ownSave?: boolean) => void
	exitImageEdit: () => void
	setLockedReadOnly: Dispatch<SetStateAction<{ forUuid: string } | null>>
	setSavedReadAs: Dispatch<SetStateAction<{ forUuid: string; versionUuid: string; encoding: string } | null>>
}

// The preview overlay's (PreviewOverlay) saves of the slot on screen: the text, spreadsheet, Word document, deck and
// PDF editors' through one write path (performSave), and the image editor's in place or as a copy (saveImage).
export function usePreviewSave({
	cacheScope,
	driveItem,
	rawDriveItem,
	editable,
	dirty,
	saving,
	setSaving,
	saveBlocked,
	anyEditing,
	editing,
	imagePrimaryTarget,
	videoEditing,
	videoCommandsRef,
	imageSaveRef,
	contentRef,
	mountedRef,
	currentSlotRef,
	remote,
	readSaveEdits,
	commitSaved,
	exitImageEdit,
	setLockedReadOnly,
	setSavedReadAs
}: UsePreviewSaveParams) {
	const { t } = useTranslation(["preview", "common", "drive"])
	// A save asked for while one was in flight (a second Mod+S, an autosave meeting one), and whether only autosaves
	// asked: run once that one settles and the file is still dirty, so no request is dropped with the deck left dirty.
	const saveAgainRef = useRef<boolean | null>(null)

	// A save that failed says why; one whose parent can never resolve (isUnresolvableParentError) leaves the slot
	// (frozen uuid) read-only, as retrying can never succeed.
	function saveFailed(dto: ErrorDTO, frozenUuid: string): void {
		setSaving(false)
		remote.saveSettled(null)
		toast.error(errorLabel(dto))

		if (isUnresolvableParentError(dto)) {
			setLockedReadOnly({ forUuid: frozenUuid })
			toast.warning(t("previewReadOnlyAfterSaveFailure"))
		}
	}

	// The one write path: encode -> upload -> patch listing -> re-key onto the rotated uuid (success), or
	// a LABEL-FIRST toast (failure) — read-only lockdown is reserved for the ONE failure class retrying
	// can never fix (isUnresolvableParentError, see previewSave.logic.ts's own comment on why); every
	// other failure leaves the buffer editable+dirty for a retry. `dirty` is reset explicitly on SUCCESS
	// below — a new `item.data.uuid` re-keys PreviewBody and the remounted viewer re-seeds a fresh
	// editor's own buffer, but a slot that mounts NO editor (markdown returns in rendered mode) would
	// otherwise never report the buffer clean. A FAILURE never remounts anything, so the buffer (and its
	// dirty bit) simply survives untouched, which is what keeps the typed content visible and the
	// close/nav prompt still armed.
	//
	// True when a save started; false when one could not start now (nothing to save, one in flight, a dialog
	// open...), which an idle autosave tries again later.
	function performSave(auto = false): boolean {
		// In edit mode a save is the image's own, never an autosave.
		if (editing !== null) {
			return !auto && imagePrimaryTarget !== null && saveImage(imagePrimaryTarget)
		}

		// The video editor's Save popover says what the export will do before anything runs.
		if (videoEditing !== null) {
			if (!auto) {
				videoCommandsRef.current?.openSave()
			}

			return false
		}

		// Locals, not the outer `driveItem`/`rawDriveItem` directly — this closure runs asynchronously, well
		// after this render's narrowing; re-binding here gives the guard below its own, freshly-narrowable copy.
		const targetItem = driveItem
		const targetRawItem = rawDriveItem

		// Nor under a dialog: over the remote-change question it would decide it for the user, and a save
		// from the unsaved-changes prompt or a menu dialog would act behind it.
		if (!editable || !dirty || targetItem === undefined || targetRawItem === undefined || saveBlocked) {
			return false
		}

		// One in flight: this one runs once it settles, if the file is still dirty then (saveAgain below).
		if (saving) {
			saveAgainRef.current = (saveAgainRef.current ?? true) && auto

			return false
		}

		setSaving(true)
		remote.saveStarted()
		void saveNow(targetItem, targetRawItem, auto)

		return true
	}

	async function saveNow(targetItem: DriveItem, targetRawItem: DriveItem, auto: boolean): Promise<void> {
		// An editor that refused to write its file (its own check failed) says why.
		const edits = await readSaveEdits(auto, true).catch((e: unknown) => {
			if (e instanceof SaveRefusedError) {
				return e
			}

			log.error("preview", "reading the edits to save failed", e)

			return null
		})

		if (edits === null || edits instanceof SaveRefusedError) {
			setSaving(false)
			remote.saveSettled(null)

			if (edits === null) {
				toast.error(t("previewSaveFailed"))
			} else if (!edits.silent) {
				const action = edits.action

				toast.error(t(edits.messageKey), {
					...(action === undefined ? {} : { action: { label: t(action.labelKey), onClick: action.run }, duration: Infinity })
				})
			}

			return
		}

		if ("kind" in edits) {
			await savePresentation(edits, targetItem, targetRawItem)

			return
		}

		const content = edits.bytes
		// The upload hands the buffer to the SDK worker; the copy seeds the saved version's preview, so the
		// editor reopens on it without downloading what it just sent.
		const saved = content.slice()

		const outcome = await runPreviewSave(
			{
				uploadFileBytes: (parentUuid, data, name, mime) => sdkApi.uploadFileBytes(parentUuid, data, name, mime),
				patchListing: driveListingQueryUpdate,
				rootUuid: currentRootUuid()
			},
			{ item: targetItem, content }
		)

		setSaving(false)

		if (outcome.status === "error") {
			saveFailed(outcome.dto, targetRawItem.data.uuid)

			return
		}

		void loadPreviewBytes(cacheScope, outcome.item.data.uuid, saved.byteLength, () => Promise.resolve(saved))
		// A spreadsheet stays mounted (keyed by its document, see bodyKey) and reports its own dirty bit:
		// edits made during the upload are still unsaved.
		edits.commit?.()

		// Text saved in a codepage: the version it made reads in that codepage.
		if (edits.encoding !== undefined) {
			const encoding = edits.encoding

			setSavedReadAs(
				encoding.startsWith("utf-") ? null : { forUuid: targetRawItem.data.uuid, versionUuid: outcome.item.data.uuid, encoding }
			)
		}

		// Keyed by the FROZEN slot uuid (targetRawItem), never targetItem's own uuid — see `saved`'s own
		// comment on why that's what makes a chained re-save of the same slot collapse onto one entry.
		commitSaved(targetRawItem.data.uuid, outcome.item, true)
		// A cut of the file now moves the saved version, not the one archived under the old uuid.
		followClipboardItem(outcome.item, targetItem.data.uuid)

		// A text editor was read-only through the upload, so it holds exactly what was saved.
		if (edits.commit === null) {
			// The remounted viewer re-seeds this itself when it mounts an editor; markdown returns in
			// RENDERED mode and mounts none, so a stale buffer would otherwise stay readable to a second save.
			dropPreviewBuffer(contentRef)
		}

		// Last, so a version saved elsewhere after this one is judged against it.
		remote.saveSettled(outcome.item)
	}

	// The image editor's saves, with performSave's guards: a new version of the file (in place) or a copy beside it.
	// Nothing to save until the image was edited.
	function saveImage(target: SaveTarget): boolean {
		const state = editing
		const targetItem = driveItem
		const targetRawItem = rawDriveItem

		if (
			state === null ||
			targetItem === undefined ||
			targetRawItem === undefined ||
			!dirty ||
			saving ||
			(target.kind === "inPlace" && !editable) ||
			saveBlocked
		) {
			return false
		}

		setSaving(true)
		remote.saveStarted()

		if (target.kind === "inPlace") {
			void saveImageInPlace(state, targetItem, targetRawItem, target)
		} else {
			void saveImageCopy(targetItem, targetRawItem, target)
		}

		return true
	}

	// A new version of the file: shown in the slot as any save is, edit mode left once it landed. A failure keeps the
	// editor and its edits for another try (or a copy, where the file turned out unwritable).
	async function saveImageInPlace(
		state: ImageEditState,
		targetItem: DriveItem,
		targetRawItem: DriveItem,
		target: Extract<SaveTarget, { kind: "inPlace" }>
	): Promise<void> {
		const written = await writeImageInPlace(targetItem, target, imageSaveRef.current).catch((e: unknown) => {
			log.error("preview", "saving the edited image failed", e)

			return null
		})

		if (written === null) {
			setSaving(false)
			remote.saveSettled(null)
			toast.error(t("previewSaveFailed"))

			return
		}

		const outcome = written.outcome

		if (outcome.status === "error") {
			saveFailed(outcome.dto, targetRawItem.data.uuid)

			return
		}

		// A slot shown from its held bytes reopens on the saved version from memory; a streamed one streams it.
		if (state.buffered && written.blob !== null) {
			await seedSavedImage(cacheScope, outcome.item.data.uuid, written.blob)
		}

		setSaving(false)
		commitSaved(targetRawItem.data.uuid, outcome.item, true)
		followClipboardItem(outcome.item, targetItem.data.uuid)
		splicePhotoSave(targetItem.data.uuid, outcome.item, "replace")
		exitImageEdit()
		remote.saveSettled(outcome.item)
	}

	// A copy beside the file: never shown in the slot nor followed by the clipboard (the file itself is unchanged);
	// its toast offers to open it.
	async function saveImageCopy(
		targetItem: DriveItem,
		targetRawItem: DriveItem,
		target: Extract<SaveTarget, { kind: "copy" }>
	): Promise<void> {
		const written = await writeImageCopy(targetItem, target, imageSaveRef.current, editedCopySuffix).catch((e: unknown) => {
			log.error("preview", "saving the edited image as a copy failed", e)

			return null
		})

		setSaving(false)

		if (written === null) {
			remote.saveSettled(null)
			toast.error(t("previewSaveFailed"))

			return
		}

		if (written.outcome.status === "error") {
			remote.saveSettled(null)
			toast.error(errorLabel(written.outcome.dto))

			return
		}

		const copy = written.outcome.item
		const frozenUuid = targetRawItem.data.uuid
		const slot = `${frozenUuid}/${targetItem.data.uuid}`

		recordOwnSave(copy.data.uuid)
		splicePhotoSave(targetItem.data.uuid, copy, "beside")
		// Left before the newer versions held through the save are judged: nothing unsaved is asked about.
		exitImageEdit()
		remote.saveSettled(null)
		toast.success(t("previewImageSaveSavedAsCopy", { name: written.name }), {
			action: {
				label: t("previewImageSaveOpenCopyAction"),
				onClick: () => {
					// Only into the slot it was saved from, still on screen, with nothing unsaved there.
					if (mountedRef.current && currentSlotRef.current === slot) {
						openSavedCopyRef.current(frozenUuid, copy)
					}
				}
			}
		})
	}

	// A deck's save: the session streams the package to the upload over a port while it reads the old file; once the
	// upload made the new file, the session moves onto it (commit), so a drive without versioning deleting the old one
	// never leaves it reading a file that is gone. The editor stays mounted (bodyKey) with its history.
	async function savePresentation(edits: PresentationSaveEdits, targetItem: DriveItem, targetRawItem: DriveItem): Promise<void> {
		// No upload at all unless the session is going to write (an untouched or fully undone deck, a refusal).
		const writes = await Promise.race([
			edits.announced,
			edits.result.then(
				() => false,
				() => false
			)
		])

		if (!writes) {
			edits.port.close()

			const result = await edits.result.catch((e: unknown) => {
				log.error("preview", "the presentation save failed", e)

				return { kind: "refused" as const, reason: "failed" as const }
			})

			setSaving(false)
			remote.saveSettled(null)

			if (result.kind === "refused") {
				toast.error(t(presentationSaveRefusalKey(result.reason)))
			}

			return
		}

		const upload = runPreviewSave(
			{
				uploadFileBytes: (parentUuid, data, name, mime) => sdkApi.uploadFileBytes(parentUuid, data, name, mime),
				uploadFileFromPort: (parentUuid, port, name, mime, size) => sdkApi.uploadFileFromPort(parentUuid, name, mime, port, size),
				patchListing: driveListingQueryUpdate,
				rootUuid: currentRootUuid()
			},
			{
				item: targetItem,
				// A PDF knows its file's exact size before the upload, and keeps the original's creation time.
				content: { port: edits.port, ...(edits.size === undefined ? {} : { size: edits.size }) },
				...(edits.times === undefined ? {} : { times: edits.times })
			}
		)
		const result = await edits.result.catch((e: unknown) => {
			log.error("preview", "the presentation save failed", e)

			return { kind: "refused" as const, reason: "failed" as const }
		})

		// A refusal is told at once and the upload behind the port ended (no new version), never waited for: an upload
		// whose reader missed the abort would never settle. One the quota pre-flight refused (it aborted the port, so the
		// writer's refusal follows) is told as the storage refusal it is.
		if (result.kind === "refused") {
			edits.port.close()
			void upload.catch(() => undefined)

			const storage = await settledStorageRefusal(upload)

			setSaving(false)
			remote.saveSettled(null)
			toast.error(storage === null ? t(presentationSaveRefusalKey(result.reason)) : errorLabel(storage))

			return
		}

		const outcome = await upload

		// Nothing to save (every edit undone): the upload was ended without a file.
		if (result.kind === "unchanged") {
			setSaving(false)
			remote.saveSettled(null)

			return
		}

		if (outcome.status === "error") {
			void edits.abandon?.()
			saveFailed(outcome.dto, targetRawItem.data.uuid)

			return
		}

		// A written save is always committed: the session holds its reads of the old file until then.
		await edits.commit(outcome.item).catch((e: unknown) => {
			log.error("preview", "moving the presentation onto its saved file failed", e)
		})
		setSaving(false)
		commitSaved(targetRawItem.data.uuid, outcome.item, true)
		followClipboardItem(outcome.item, targetItem.data.uuid)
		remote.saveSettled(outcome.item)
	}

	// Idle autosave (the Word document editor's, the spreadsheet editor's) runs the same save, with its guards, as it
	// stands now.
	const performSaveRef = useLatestRef(performSave)
	// A saved copy's Open, as things stand when it is clicked: not over edits or a save.
	const openSavedCopyRef = useLatestRef((frozenUuid: string, copy: DriveItem) => {
		if (!anyEditing && !dirty && !saving) {
			commitSaved(frozenUuid, copy)
		}
	})

	useEffect(() => {
		const auto = saveAgainRef.current

		if (saving || auto === null) {
			return
		}

		saveAgainRef.current = null

		if (dirty) {
			performSaveRef.current(auto)
		}
	}, [saving, dirty, performSaveRef])

	return { performSave, performSaveRef, saveImage }
}
