import * as Comlink from "comlink"
import { onlineManager } from "@tanstack/react-query"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { takenNamesInDirectory } from "@/features/drive/lib/nameTaken"
import { checkUploadQuota } from "@/features/drive/lib/quota"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { cancelTransfer } from "@/features/transfers/lib/control"
import { transferById, useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { watchState } from "@/features/videos/lib/watchState"
import { exporter } from "@/features/preview/videoEdit/exportClient"
import type { VideoSaveDeps } from "@/features/preview/videoEdit/save"
import { runOp } from "@/lib/actions/outcome"
import { isAppleMobile } from "@/lib/appleMobile"
import { holdForegroundRendering } from "@/lib/desktop"
import { playbackCapabilities } from "@/lib/media/playback/capabilities"
import { createScreenWakeLock } from "@/lib/media/wakeLock"
import { sdkApi } from "@/lib/sdk/client"
import { accountQueryGet } from "@/queries/account"

// startVideoSave's collaborators as the app has them.
export function videoSaveDeps(): VideoSaveDeps {
	return {
		isOnline: () => onlineManager.isOnline(),
		encodeCapabilities: () => playbackCapabilities.encodeCapabilities(),
		versioning: () => accountQueryGet()?.versioningEnabled,
		ios: isAppleMobile,
		rootUuid: currentRootUuid,
		getFileByStableUuid: stableUuid => runOp(sdkApi.getFileByStableUuid(stableUuid)),
		takenNames: takenNamesInDirectory,
		openSourcePort: (port, item, token) => sdkApi.openRangePort(Comlink.transfer(port, [port]), narrowToAnyFile(item), token),
		cancelSourceReads: token => {
			void sdkApi.cancelPreviewDownload(token)
		},
		exporter,
		saveDeps: {
			uploadFileBytes: (parentUuid, data, name, mime, options) => sdkApi.uploadFileBytes(parentUuid, data, name, mime, options),
			uploadFileFromPort: (parentUuid, port, name, mime, options) => sdkApi.uploadFileFromPort(parentUuid, name, mime, port, options),
			patchListing: driveListingQueryUpdate,
			rootUuid: currentRootUuid()
		},
		checkQuota: checkUploadQuota,
		transfers: useTransfersStore.getState(),
		isPaused: id => transferById(useTransfersStore.getState().transfers, id)?.paused === true,
		cancelTransfer,
		rebaseWatchState: params => watchState.rebaseEdited(params),
		// The screen stays on, and the desktop app keeps rendering this window at full speed while it is hidden.
		keepAwake: () => {
			const lock = createScreenWakeLock({ needed: true })
			const releaseRendering = holdForegroundRendering()

			lock.set(true)

			return () => {
				lock.dispose()
				releaseRendering()
			}
		},
		now: () => Date.now(),
		setInterval: (run, ms) => setInterval(run, ms),
		clearInterval: handle => {
			clearInterval(handle as ReturnType<typeof setInterval>)
		}
	}
}
