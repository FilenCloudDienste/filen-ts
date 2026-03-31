import { create } from "zustand"
import * as FileSystem from "expo-file-system"
import type { AnyNormalDir, FilenSdkErrorInterface, UploadError, DownloadError, NonRootItem } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

export type Transfer = {
	id: string
	size: number
	bytesTransferred: number
	startedAt: number
	paused: boolean
	abort: () => void
	pause: () => void
	resume: () => void
} & (
	| {
			type: "uploadDirectory"
			knownFiles: number
			knownDirectories: number
			errors: {
				upload: UploadError[]
				scan: FilenSdkErrorInterface[]
				unknown: Error[]
			}
			localFileOrDir: FileSystem.File | FileSystem.Directory
			parent: AnyNormalDir
	  }
	| {
			type: "uploadFile"
			errors: {
				upload: UploadError[]
				scan: FilenSdkErrorInterface[]
				unknown: Error[]
			}
			localFileOrDir: FileSystem.File | FileSystem.Directory
			parent: AnyNormalDir
	  }
	| {
			type: "downloadFile"
			errors: {
				download: (Omit<DownloadError, "item"> & {
					item?: NonRootItem
				})[]
				scan: FilenSdkErrorInterface[]
				unknown: Error[]
			}
			item: DriveItem
			destination: FileSystem.File
	  }
	| {
			type: "downloadDirectory"
			knownFiles: number
			knownDirectories: number
			directoryQueryProgress: {
				bytesTransferred: number
				totalBytes: number
			}
			errors: {
				download: (Omit<DownloadError, "item"> & {
					item?: NonRootItem
				})[]
				scan: FilenSdkErrorInterface[]
				unknown: Error[]
			}
			item: DriveItem
			destination: FileSystem.Directory
	  }
)

let interval: ReturnType<typeof setInterval> | undefined

function updateTransfers({
	transfers,
	state,
	addToNextUpdateAt
}: {
	transfers: Transfer[]
	state: TransfersStore
	addToNextUpdateAt: boolean
}): {
	transfers: Transfer[]
	stats: TransfersStore["stats"]
} {
	const now = Date.now()

	if (transfers.length === 0 && interval) {
		clearInterval(interval)

		interval = undefined
	}

	if (!interval && transfers.length > 0) {
		interval = setInterval(() => {
			useTransfersStore.setState(state =>
				updateTransfers({
					transfers: state.transfers,
					state,
					addToNextUpdateAt: false
				})
			)
		}, 1000)
	}

	if (now < state.stats.nextUpdateAt) {
		return {
			transfers,
			stats: state.stats
		}
	}

	let activeTransfersTotalBytesTransferred = 0
	let activeTransfersTotalSize = 0
	let pausedTransfersCount = 0

	for (const transfer of transfers) {
		activeTransfersTotalBytesTransferred += transfer.bytesTransferred
		activeTransfersTotalSize += transfer.size

		if (transfer.paused) {
			pausedTransfersCount++
		}
	}

	const bytesDelta = activeTransfersTotalBytesTransferred - state.stats.lastBytesTransferred
	const timeDelta = now - (state.stats.lastUpdateTime === 0 ? now - 1000 : state.stats.lastUpdateTime)

	return {
		transfers,
		stats: {
			speed: pausedTransfersCount === transfers.length ? 0 : timeDelta > 0 ? Math.max(0, bytesDelta / timeDelta) : 0,
			lastBytesTransferred: activeTransfersTotalBytesTransferred,
			lastUpdateTime: now,
			progress:
				activeTransfersTotalSize > 0
					? Math.min(1, Math.max(0, activeTransfersTotalBytesTransferred / activeTransfersTotalSize))
					: 0,
			count: transfers.length,
			nextUpdateAt: addToNextUpdateAt ? now + 500 : state.stats.nextUpdateAt
		}
	}
}

export type TransfersStore = {
	transfers: Transfer[]
	stats: {
		progress: number
		speed: number
		lastBytesTransferred: number
		lastUpdateTime: number
		count: number
		nextUpdateAt: number
	}
	setTransfers: (fn: Transfer[] | ((prev: Transfer[]) => Transfer[])) => void
}

export const useTransfersStore = create<TransfersStore>(set => ({
	transfers: [],
	stats: {
		progress: 0,
		speed: 0,
		lastBytesTransferred: 0,
		lastUpdateTime: 0,
		count: 0,
		nextUpdateAt: 0
	} satisfies TransfersStore["stats"],
	setTransfers(fn) {
		set(state => {
			const transfers = typeof fn === "function" ? fn(state.transfers) : fn

			return updateTransfers({
				transfers,
				state,
				addToNextUpdateAt: true
			})
		})
	}
}))

export default useTransfersStore
