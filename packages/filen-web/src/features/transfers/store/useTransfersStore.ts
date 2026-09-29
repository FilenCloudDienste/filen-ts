import { useEffect } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { DriveItem } from "@/features/drive/lib/item"
import { clampedRatio } from "@filen/shared"
import { withoutKey } from "@/lib/utils"

// One row per in-flight or finished transfer, in-memory only (no persistence — mirrors
// useDriveStore's selection state, not a query). "upload" and "download" rows come from
// features/drive/lib/upload.ts's runUpload and features/drive/lib/download.ts's runDownload (a zip
// transfer is one row too — features/drive/lib/downloadZip.ts's runZipDownload); a "copy" row is one
// whole copy job (features/drive/lib/copy.ts), never one row per copied file. "cancelled" is a
// real, if short-lived, status: a cancel path settles to it then immediately removes the row (mobile
// parity — no history entry for an aborted transfer), so it is never expected to render.
// "completedWithErrors" is a copy that finished with some of its items failed.
export interface Transfer {
	id: string
	direction: "upload" | "download" | "copy"
	name: string
	size: number
	bytesTransferred: number
	status: "uploading" | "downloading" | "copying" | "done" | "error" | "cancelled" | "completedWithErrors"
	// Suspended-in-place flag for an ACTIVE transfer — set via setPaused, never via settle. Never
	// implies a status change: a paused transfer keeps its active status (isActiveTransfer
	// stays true), just not currently receiving bytes/progress until resumed.
	paused: boolean
	// Present only once status is "error" — exactOptionalPropertyTypes forbids assigning `undefined`
	// to this key explicitly, so settle() below only ever spreads it in when actually provided.
	error?: ErrorDTO
	parentUuid: string | null
	startedAt: number
	// A landed upload's own file, which its row's "Show in directory" reveals.
	item?: DriveItem
}

// Every terminal state settle() can drive a transfer to. Kept separate from Transfer["status"]
// (which also carries the ACTIVE states) so a call site can never accidentally settle a transfer to
// "uploading"/"downloading"/"copying".
export type TerminalStatus = "done" | "error" | "cancelled" | "completedWithErrors"

// The single "is this row still in flight" predicate — replaces every direct `status ===
// "uploading"` sentinel so every active status counts identically.
export function isActiveTransfer(status: Transfer["status"]): boolean {
	return status === "uploading" || status === "downloading" || status === "copying"
}

export function hasActiveTransfers(transfers: readonly Transfer[]): boolean {
	return transfers.some(transfer => isActiveTransfer(transfer.status))
}

export function hasActiveCopies(transfers: readonly Transfer[]): boolean {
	return transfers.some(transfer => transfer.direction === "copy" && isActiveTransfer(transfer.status))
}

// Drop the OLDEST finished (non-active) rows once the finished count exceeds the cap — active rows
// are never dropped. `transfers` is insertion-ordered (add() appends), so array position already IS
// startedAt order; this walks forward and only skips (drops) the first `excess` finished rows it
// meets, keeping every later one — mirrors mobile's MAX_FINISHED_TRANSFERS.
const MAX_FINISHED_TRANSFERS = 200

export function capFinishedTransfers(transfers: Transfer[]): Transfer[] {
	let finishedCount = 0

	for (const transfer of transfers) {
		if (!isActiveTransfer(transfer.status)) {
			finishedCount++
		}
	}

	let toDrop = finishedCount - MAX_FINISHED_TRANSFERS

	if (toDrop <= 0) {
		return transfers
	}

	const kept: Transfer[] = []

	for (const transfer of transfers) {
		if (toDrop > 0 && !isActiveTransfer(transfer.status)) {
			toDrop--
			continue
		}

		kept.push(transfer)
	}

	return kept
}

// One (timestamp, totalBytes) sample — the raw material for the rolling-window speed below. For the
// aggregate, totalBytes counts every byte moved since the window last emptied, never the live sum over
// active rows: a transfer that settles or is removed would take its bytes out of that sum, and a batch
// of many small files would read as no speed at all. `setProgress` appends a sample on every progress
// tick and trims anything outside the window, so the array itself never grows past a handful of
// entries during an active transfer, and stops growing at all once everything settles.
export interface SpeedSample {
	timestamp: number
	totalBytes: number
}

const SPEED_WINDOW_MS = 5_000

// Pure and independently testable (vi.useFakeTimers()/vi.setSystemTime() drives `Date.now()`
// deterministically in tests, same technique upload.test.ts already uses for the progress
// throttle). Bytes/sec across the window: the earliest and latest samples still inside the last 5s
// anchor the rate. Fewer than two in-window samples (transfer just started, or nothing has
// progressed in the last 5s) reads 0 rather than a NaN/Infinity spike.
export function computeTransfersSpeed(samples: readonly SpeedSample[]): number {
	const windowStart = Date.now() - SPEED_WINDOW_MS
	const inWindow = samples.filter(sample => sample.timestamp >= windowStart)
	const first = inWindow[0]
	const last = inWindow[inWindow.length - 1]

	if (inWindow.length < 2 || first === undefined || last === undefined) {
		return 0
	}

	const elapsedMs = last.timestamp - first.timestamp

	if (elapsedMs <= 0) {
		return 0
	}

	return Math.max(0, ((last.totalBytes - first.totalBytes) / elapsedMs) * 1000)
}

export interface TransfersStore {
	transfers: Transfer[]
	// Rolling-window input for computeTransfersSpeed — store-owned since setProgress is the only
	// place bytesTransferred actually changes over time; never written to directly by a consumer.
	speedSamples: SpeedSample[]
	// The same rolling window per active transfer, over its own bytesTransferred, for the row's speed and
	// time left. Dropped once the transfer settles or its window empties; a copy's row reads its job instead.
	rowSpeedSamples: Readonly<Record<string, SpeedSample[]>>
	// Omits `paused` — every newly added transfer starts unpaused, enforced here rather than trusted
	// to each call site (features/drive/lib/upload.ts's runUpload, features/drive/lib/download.ts's runDownload).
	add: (transfer: Omit<Transfer, "paused">) => void
	setProgress: (id: string, bytesTransferred: number) => void
	// Updates a transfer's total size after add() — every upload and single-file download already
	// knows its size upfront (the source File/DriveItem carries it), but a zip transfer's total isn't
	// known until the SDK's own progress callback reports it, and can keep growing as the recursive
	// walk discovers more files (features/drive/lib/downloadZip.ts's runZipDownload adds the row at size 0 and
	// calls this on every throttled tick).
	setSize: (id: string, size: number) => void
	// Flips ONLY the paused flag — never touches status (paused is not a terminal state; see
	// Transfer["paused"]'s own comment). Backs the active-row pause/resume toggle
	// (features/transfers/lib/control.ts's pauseTransfer/resumeTransfer).
	setPaused: (id: string, paused: boolean) => void
	settle: (id: string, status: TerminalStatus, error?: ErrorDTO) => void
	setItem: (id: string, item: DriveItem) => void
	remove: (id: string) => void
	// Drops every finished (non-active) row; active transfers are left untouched. Backs the
	// transfers panel's "clear finished" control.
	clearFinished: () => void
	// Drops every sample that has left the window (useSpeedSampleAging's tick). Writes nothing when
	// nothing aged out.
	pruneSpeedSamples: () => void
}

// The samples still inside the window starting at `windowStart`; the same array when none aged out.
// Samples are appended in time order, so the aged ones are a prefix.
function samplesSince(samples: SpeedSample[], windowStart: number): SpeedSample[] {
	const firstKept = samples.findIndex(sample => sample.timestamp >= windowStart)

	if (firstKept === 0) {
		return samples
	}

	return firstKept === -1 ? [] : samples.slice(firstKept)
}

// Keeps only the samples of transfers that are still active; the same object when nothing goes.
function rowSamplesOfActive(
	record: Readonly<Record<string, SpeedSample[]>>,
	transfers: readonly Transfer[]
): Readonly<Record<string, SpeedSample[]>> {
	let out = record

	for (const id in record) {
		if (!transfers.some(transfer => transfer.id === id && isActiveTransfer(transfer.status))) {
			out = withoutKey(out, id)
		}
	}

	return out
}

export function hasSpeedSamples(state: Pick<TransfersStore, "speedSamples" | "rowSpeedSamples">): boolean {
	return state.speedSamples.length > 0 || Object.keys(state.rowSpeedSamples).length > 0
}

export const useTransfersStore = create<TransfersStore>(set => ({
	transfers: [],
	speedSamples: [],
	rowSpeedSamples: {},
	add: transfer => {
		set(state => ({ transfers: [...state.transfers, { ...transfer, paused: false }] }))
	},
	setPaused: (id, paused) => {
		set(state => ({
			transfers: state.transfers.map(transfer => (transfer.id === id ? { ...transfer, paused } : transfer))
		}))
	},
	setProgress: (id, bytesTransferred) => {
		set(state => {
			const target = state.transfers.find(transfer => transfer.id === id)

			// A throttled trailing tick can land after its transfer settled or was removed: nothing to update,
			// and a sample written for it would never be dropped.
			if (target === undefined || !isActiveTransfer(target.status)) {
				return state
			}

			const transfers = state.transfers.map(transfer => (transfer === target ? { ...transfer, bytesTransferred } : transfer))
			const now = Date.now()
			// A restarted transfer reporting fewer bytes moved none.
			const totalBytes = (state.speedSamples.at(-1)?.totalBytes ?? 0) + Math.max(0, bytesTransferred - target.bytesTransferred)
			const windowStart = now - SPEED_WINDOW_MS
			const speedSamples = samplesSince([...state.speedSamples, { timestamp: now, totalBytes }], windowStart)

			if (target.direction === "copy") {
				return { transfers, speedSamples }
			}

			const rowSamples = samplesSince(
				[...(state.rowSpeedSamples[id] ?? []), { timestamp: now, totalBytes: bytesTransferred }],
				windowStart
			)

			return { transfers, speedSamples, rowSpeedSamples: { ...state.rowSpeedSamples, [id]: rowSamples } }
		})
	},
	setSize: (id, size) => {
		set(state => ({
			transfers: state.transfers.map(transfer => (transfer.id === id ? { ...transfer, size } : transfer))
		}))
	},
	settle: (id, status, error) => {
		set(state => {
			const transfers = state.transfers.map(transfer =>
				transfer.id === id ? (error === undefined ? { ...transfer, status } : { ...transfer, status, error }) : transfer
			)

			// "cancelled" never joins history — every caller removes the row immediately after settling it
			// (runDownload/runZipDownload/runUpload's own Cancelled branch) — so it must never count toward
			// the finished cap either, or that transient row can evict an OLDER, still-legitimate finished
			// row an instant before it is itself removed.
			return {
				transfers: status === "cancelled" ? transfers : capFinishedTransfers(transfers),
				rowSpeedSamples: rowSamplesOfActive(state.rowSpeedSamples, transfers)
			}
		})
	},
	setItem: (id, item) => {
		set(state => ({
			transfers: state.transfers.map(transfer => (transfer.id === id ? { ...transfer, item } : transfer))
		}))
	},
	remove: id => {
		set(state => ({
			transfers: state.transfers.filter(transfer => transfer.id !== id),
			rowSpeedSamples: withoutKey(state.rowSpeedSamples, id)
		}))
	},
	clearFinished: () => {
		set(state => {
			const transfers = state.transfers.filter(transfer => isActiveTransfer(transfer.status))

			return { transfers, rowSpeedSamples: rowSamplesOfActive(state.rowSpeedSamples, transfers) }
		})
	},
	pruneSpeedSamples: () => {
		set(state => {
			const windowStart = Date.now() - SPEED_WINDOW_MS
			const speedSamples = samplesSince(state.speedSamples, windowStart)
			let rowSpeedSamples = state.rowSpeedSamples

			for (const [id, samples] of Object.entries(state.rowSpeedSamples)) {
				const kept = samplesSince(samples, windowStart)

				if (kept !== samples) {
					rowSpeedSamples = kept.length === 0 ? withoutKey(rowSpeedSamples, id) : { ...rowSpeedSamples, [id]: kept }
				}
			}

			return speedSamples === state.speedSamples && rowSpeedSamples === state.rowSpeedSamples
				? state
				: { speedSamples, rowSpeedSamples }
		})
	}
}))

const SPEED_SAMPLE_AGING_INTERVAL_MS = 1_000

// A speed is recomputed only when its samples change, and a stalled transfer sends no progress, so
// without this its last speed and time left would stand forever. One tick for the whole screen, and
// only while some window holds samples, which a stall or a pause empties within the window's length.
export function useSpeedSampleAging(): void {
	const sampling = useTransfersStore(hasSpeedSamples)

	useEffect(() => {
		if (!sampling) {
			return
		}

		const timer = setInterval(() => {
			useTransfersStore.getState().pruneSpeedSamples()
		}, SPEED_SAMPLE_AGING_INTERVAL_MS)

		return () => {
			clearInterval(timer)
		}
	}, [sampling])
}

// Plain, testable aggregate math — mirrors fetchDirectoryListing/useDirectoryListingQuery's split
// (queries/drive.ts): the hook below is a one-line wrapper this project's node-environment unit
// tests can't render (no DOM — see vitest.config.ts), so the math itself is exported and unit-tested
// directly against plain Transfer arrays. `percent` is already scaled 0-100 (summed transferred /
// summed size across active rows, times 100) — a consumer feeds it straight into a progress bar,
// never multiplies again. `speedSamples` is optional (defaults to empty -> speed 0) so every existing
// single-argument call site stays valid.
export function computeTransfersAggregate(
	transfers: Transfer[],
	speedSamples: readonly SpeedSample[] = []
): { activeCount: number; percent: number; speed: number } {
	let activeCount = 0
	let transferred = 0
	let total = 0

	for (const transfer of transfers) {
		if (!isActiveTransfer(transfer.status)) {
			continue
		}

		activeCount++

		// A transfer whose size is not known yet (a zip still walking its tree) has no share of the whole
		// to report; its bytes alone would push the percent past what is actually done.
		if (transfer.size > 0) {
			transferred += transfer.bytesTransferred
			total += transfer.size
		}
	}

	return {
		activeCount,
		percent: clampedRatio(transferred, total, 100),
		speed: computeTransfersSpeed(speedSamples)
	}
}

// Selector hook, not a plain accessor — React-Compiler standing constraint: a component reads this
// store through a selector hook returning primitives/stable refs, never `.getState()` in render.
// useShallow keeps the returned object's IDENTITY stable across renders where neither field actually
// changed (mirrors directoryListing.tsx's own useShallow(state => state.selectedItems)), since
// computeTransfersAggregate otherwise returns a brand-new object on every store update. `percent` is
// 0-100, ready to feed straight into a progress bar — not a 0..1 ratio.
export function useTransfersAggregate(): { activeCount: number; percent: number; speed: number } {
	return useTransfersStore(useShallow(state => computeTransfersAggregate(state.transfers, state.speedSamples)))
}

// Boolean-collapsed, so a progress tick re-renders a subscriber only on the has/has-not edge.
export function useHasActiveTransfers(): boolean {
	return useTransfersStore(state => hasActiveTransfers(state.transfers))
}
