import { create } from "zustand"
import * as FileSystem from "expo-file-system"
import type { AnyNormalDir, FilenSdkErrorInterface, UploadError, DownloadError, NonRootItem } from "@filen/sdk-rs"
import type {
	DriveItemDirectory,
	DriveItemFileShared,
	DriveItemFile,
	DriveItemDirectorySharedNonRoot,
	DriveItemDirectorySharedRoot
} from "@/types"

export type Transfer = {
	id: string
	size: number
	bytesTransferred: number
	startedAt: number
	finishedAt?: number
	paused: boolean
	aborted: boolean
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
			item: DriveItemFile | DriveItemFileShared
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
			item: DriveItemDirectory | DriveItemDirectorySharedNonRoot | DriveItemDirectorySharedRoot
			destination: FileSystem.Directory
	  }
)

function updateTransfers({ transfers, state }: { transfers: Transfer[]; state: TransfersStore }): {
	transfers: Transfer[]
	stats: TransfersStore["stats"]
} {
	const activeTransfers = transfers.filter(t => !t.finishedAt)

	if (activeTransfers.length === 0) {
		clearInterval(state.stats.interval)

		return {
			transfers,
			stats: {
				speed: 0,
				progress: 0,
				lastBytesTransferred: 0,
				lastUpdateTime: 0,
				count: 0,
				interval: undefined,
				nextUpdateAt: 0
			}
		}
	}

	const now = Date.now()

	if (now < state.stats.nextUpdateAt) {
		return {
			transfers,
			stats: state.stats
		}
	}

	let activeTransfersTotalBytesTransferred = 0
	let activeTransfersTotalSize = 0

	for (const transfer of activeTransfers) {
		activeTransfersTotalBytesTransferred += transfer.bytesTransferred
		activeTransfersTotalSize += transfer.size
	}

	const bytesDelta = activeTransfersTotalBytesTransferred - state.stats.lastBytesTransferred
	const timeDelta = now - (state.stats.lastUpdateTime === 0 ? now - 1000 : state.stats.lastUpdateTime)

	let interval = state.stats.interval

	if (!interval) {
		interval = setInterval(() => {
			useTransfersStore.setState(state =>
				updateTransfers({
					transfers: state.transfers,
					state
				})
			)
		}, 1000)
	}

	return {
		transfers,
		stats: {
			speed: timeDelta > 0 ? Math.max(0, bytesDelta / timeDelta) : 0,
			lastBytesTransferred: activeTransfersTotalBytesTransferred,
			lastUpdateTime: now,
			progress:
				activeTransfersTotalSize > 0
					? Math.min(1, Math.max(0, activeTransfersTotalBytesTransferred / activeTransfersTotalSize))
					: 0,
			count: activeTransfers.length,
			interval,
			nextUpdateAt: now + 500
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
		interval: ReturnType<typeof setInterval> | undefined
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
		interval: undefined,
		nextUpdateAt: 0
	} satisfies TransfersStore["stats"],
	setTransfers(fn) {
		set(state => {
			const transfers = typeof fn === "function" ? fn(state.transfers) : fn

			return updateTransfers({
				transfers,
				state
			})
		})
	}
}))

export default useTransfersStore
