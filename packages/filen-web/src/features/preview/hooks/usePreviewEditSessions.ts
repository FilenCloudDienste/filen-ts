import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { canEditImage, canEditVideo } from "@/features/drive/lib/previewSave.logic"
import { stableUuidOf } from "@/features/drive/store/useDriveClipboardStore"
import { copyTargetOf, type SlotPin } from "@/features/preview/components/previewOverlay.logic"
import type { ImageEditState } from "@/features/preview/imageEdit/editSession"
import type { SaveTarget } from "@/features/preview/imageEdit/types"
import { createVideoEditClient } from "@/features/preview/videoEdit/client"
import { isVideoExportRunning, subscribeVideoExports } from "@/features/preview/videoEdit/save"
import { knownUnpreviewable, useVideoEditMode } from "@/features/preview/videoEdit/useVideoEditMode"

interface UsePreviewEditSessionsParams {
	variant: DriveVariant
	asText: boolean
	driveItem: DriveItem | undefined
	rawDriveItem: DriveItem | undefined
	pin: SlotPin | null
	editable: boolean
}

// The preview overlay's (PreviewOverlay) image and video editor sessions, each held for the slot and the version it
// opened on, and whether either editor may open on the slot on screen.
export function usePreviewEditSessions({ variant, asText, driveItem, rawDriveItem, pin, editable }: UsePreviewEditSessionsParams) {
	// The image editor's session, for the slot and the version it opened on: another file on screen (a newer version
	// loaded, the slot gone) leaves edit mode, and the effect below ends the session.
	const [editState, setEditState] = useState<ImageEditState | null>(null)
	const editing =
		editState !== null && rawDriveItem?.data.uuid === editState.frozenUuid && driveItem?.data.uuid === editState.uuid ? editState : null

	if (editState !== null && editing === null) {
		setEditState(null)
	}

	// Opening the editor (sniffing, the worker's probe, the source's decode) is under way.
	const [enteringEdit, setEnteringEdit] = useState(false)
	const enterAbortRef = useRef<AbortController | null>(null)
	// The slot shows an image the editor can open (saved in place, or as a copy for a format it cannot write).
	const imageEditable = driveItem !== undefined && !asText && pin?.category === "image" && canEditImage(driveItem, variant)
	// The header's Save: a new version where the format is written in place and the slot may be, else the copy.
	const imagePrimaryTarget: SaveTarget | null =
		editing === null ? null : editing.targets.primary.kind === "inPlace" && editable ? editing.targets.primary : copyTargetOf(editing)

	// The video editor's session, for the slot and the version it opened on, as the image editor's: another file on
	// screen leaves video edit mode (the effect below), which ends its client.
	const videoMode = useVideoEditMode(item => createVideoEditClient({ item }))
	const videoState = videoMode.state
	const videoEditing =
		videoState !== null && rawDriveItem?.data.uuid === videoState.frozenUuid && driveItem?.data.uuid === videoState.uuid
			? videoState
			: null
	const videoStale = videoState !== null && videoEditing === null
	const exitVideoMode = videoMode.exit

	useEffect(() => {
		if (videoStale) {
			exitVideoMode()
		}
	}, [videoStale, exitVideoMode])

	// The slot shows a video the editor may open: in the user's own drive, in a container the export reads, and not
	// already found to have no picture this browser shows.
	const videoEditable =
		driveItem !== undefined &&
		!asText &&
		pin?.category === "video" &&
		canEditVideo(driveItem, variant) &&
		!knownUnpreviewable(driveItem.data.uuid)
	// A save of this video still runs (in an editor gone to the background, or a transfer): a second one would race it for
	// the same name or version, so Edit waits until it ends. Live, so the button says so before it is pressed.
	const videoExportRunning = useSyncExternalStore(
		subscribeVideoExports,
		() => driveItem !== undefined && isVideoExportRunning(stableUuidOf(driveItem) ?? driveItem.data.uuid)
	)
	// Either editor is open: the viewer's header, keys and saves step aside.
	const anyEditing = editing !== null || videoEditing !== null

	// Leaving edit mode, or the overlay, ends the session: the render worker's idle teardown starts then.
	useEffect(() => {
		if (editState === null) {
			return
		}

		const state = editState

		return () => {
			state.release()
		}
	}, [editState])

	return {
		setEditState,
		editing,
		enteringEdit,
		setEnteringEdit,
		enterAbortRef,
		imageEditable,
		imagePrimaryTarget,
		videoMode,
		videoEditing,
		videoEditable,
		videoExportRunning,
		anyEditing
	}
}
