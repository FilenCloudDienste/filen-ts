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

// Speed smoothing. The Rust SDK only emits byte-transferred events when the
// network delivers a chunk — on slow or jittery mobile connections that
// produces irregular bursts and brief 1-2 second blips between cell towers.
// A 5-second rolling window over cumulative bytes turns "burst, gap, burst"
// into a stable bytes/sec figure and absorbs typical cellular hiccups
// without flashing through zero.
const SPEED_WINDOW_MS = 5000
const STATS_UPDATE_THROTTLE_MS = 100

type Sample = {
	time: number
	cumulativeBytes: number
}

// Module-level speed state, isolated from the React store. None of this is
// consumed by UI; it just produces the smoothed `speed` value.
let interval: ReturnType<typeof setInterval> | undefined
let nextUpdateAt = 0
let lastTotalBytes = 0
let cumulativeBytes = 0
let samples: Sample[] = []

function resetSpeedState(): void {
	if (interval) {
		clearInterval(interval)
		interval = undefined
	}

	nextUpdateAt = 0
	lastTotalBytes = 0
	cumulativeBytes = 0
	samples = []
}

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

	// Tear down when the batch finishes.
	if (transfers.length === 0) {
		resetSpeedState()

		if (state.stats.count === 0 && state.stats.progress === 0 && state.stats.speed === 0) {
			return {
				transfers,
				stats: state.stats
			}
		}

		return {
			transfers,
			stats: {
				progress: 0,
				speed: 0,
				count: 0
			}
		}
	}

	// Spin up the back-stop interval when a new batch starts. Without it, a
	// long pause between SDK events would freeze the displayed stats; the
	// interval keeps advancing the speed window so speed decays naturally
	// toward 0 on a stalled connection.
	if (!interval) {
		interval = setInterval(() => {
			useTransfersStore.setState(s =>
				updateTransfers({
					transfers: s.transfers,
					state: s,
					addToNextUpdateAt: false
				})
			)
		}, STATS_UPDATE_THROTTLE_MS)

		// Establish a baseline anchor so the first measured interval produces
		// a meaningful (non-spike) speed.
		nextUpdateAt = 0
		lastTotalBytes = 0
		cumulativeBytes = 0
		samples = [
			{
				time: now,
				cumulativeBytes: 0
			}
		]
	}

	// Throttle stats updates to a fixed cadence. SDK-driven calls advance the
	// throttle so a flood of byte events doesn't recompute N times per second;
	// interval-driven calls don't, so an SDK event can squeeze in if it
	// arrives shortly after the interval has already fired.
	if (now < nextUpdateAt) {
		return {
			transfers,
			stats: state.stats
		}
	}

	let totalBytesTransferred = 0
	let totalSize = 0
	let pausedCount = 0

	for (const transfer of transfers) {
		totalBytesTransferred += transfer.bytesTransferred
		totalSize += transfer.size

		if (transfer.paused) {
			pausedCount++
		}
	}

	// Append a cumulative-bytes sample. Clamping at 0 handles the brief moment
	// when a completed transfer is removed from the array before a new one's
	// bytes catch up — cumulativeBytes never decreases, so window deltas are
	// always a meaningful "bytes transferred since N seconds ago".
	const delta = Math.max(0, totalBytesTransferred - lastTotalBytes)

	cumulativeBytes += delta
	lastTotalBytes = totalBytesTransferred

	samples.push({
		time: now,
		cumulativeBytes
	})

	// Trim samples older than the window. Keep at least one sample so the
	// window always has an anchor to compute a delta against.
	const cutoff = now - SPEED_WINDOW_MS
	let dropCount = 0

	while (dropCount < samples.length - 1 && (samples[dropCount] as Sample).time < cutoff) {
		dropCount++
	}

	if (dropCount > 0) {
		samples = samples.slice(dropCount)
	}

	let speed = 0

	if (pausedCount < transfers.length && samples.length >= 2) {
		const oldest = samples[0] as Sample
		const newest = samples[samples.length - 1] as Sample
		const timeDelta = newest.time - oldest.time

		if (timeDelta > 0) {
			// (bytes_in_window * 1000) / window_span_ms = bytes/sec
			speed = ((newest.cumulativeBytes - oldest.cumulativeBytes) * 1000) / timeDelta
		}
	}

	const progress = totalSize > 0 ? Math.min(1, Math.max(0, totalBytesTransferred / totalSize)) : 0

	if (addToNextUpdateAt) {
		nextUpdateAt = now + STATS_UPDATE_THROTTLE_MS
	}

	return {
		transfers,
		stats: {
			progress,
			speed,
			count: transfers.length
		}
	}
}

export type TransfersStore = {
	transfers: Transfer[]
	stats: {
		progress: number
		speed: number
		count: number
	}
	setTransfers: (fn: Transfer[] | ((prev: Transfer[]) => Transfer[])) => void
}

export const useTransfersStore = create<TransfersStore>(set => ({
	transfers: [],
	stats: {
		progress: 0,
		speed: 0,
		count: 0
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
