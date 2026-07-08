import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import type { ErrorDTO } from "@/lib/sdk/errors"

// One row per in-flight or finished transfer, in-memory only (no persistence — mirrors
// useDriveStore's selection state, not a query). `direction` now carries real "download" rows
// alongside "upload" (lib/drive/upload.ts's runUpload, lib/drive/download.ts's runDownload, including
// a zip transfer's own single row — lib/drive/download-zip.ts's runZipDownload). "cancelled" is a
// real, if short-lived, status: a download's cancel path settles to it then immediately removes the
// row (mobile parity — no history entry for an aborted transfer), so it is never expected to render.
// "completedWithErrors" stays unused: it models a resolve-with-per-entry-failures outcome, but the
// SDK's zip op rejects the WHOLE call on any real failure rather than signalling a partial one (see
// runZipDownload's own comment) — nothing settles to this status today.
export interface Transfer {
	id: string
	direction: "upload" | "download"
	name: string
	size: number
	bytesTransferred: number
	status: "uploading" | "downloading" | "done" | "error" | "cancelled" | "completedWithErrors"
	// Suspended-in-place flag for an ACTIVE transfer — set via setPaused, never via settle. Never
	// implies a status change: a paused transfer is still "uploading"/"downloading" (isActiveTransfer
	// stays true), just not currently receiving bytes/progress until resumed.
	paused: boolean
	// Present only once status is "error" — exactOptionalPropertyTypes forbids assigning `undefined`
	// to this key explicitly, so settle() below only ever spreads it in when actually provided.
	error?: ErrorDTO
	parentUuid: string | null
	startedAt: number
}

// Every terminal state settle() can drive a transfer to. Kept separate from Transfer["status"]
// (which also carries the two ACTIVE states) so a call site can never accidentally settle a
// transfer to "uploading"/"downloading".
export type TerminalStatus = "done" | "error" | "cancelled" | "completedWithErrors"

// The single "is this row still in flight" predicate — replaces every direct `status ===
// "uploading"` sentinel so a downloading row counts as active identically to an uploading one.
export function isActiveTransfer(status: Transfer["status"]): boolean {
	return status === "uploading" || status === "downloading"
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

// One (timestamp, totalBytes-across-active-transfers) sample — the raw material for the rolling-
// window speed below. `setProgress` appends a sample on every progress tick and trims anything
// outside the window, so the array itself never grows past a handful of entries during an active
// transfer, and stops growing at all once everything settles.
export interface SpeedSample {
	timestamp: number
	totalBytes: number
}

const SPEED_WINDOW_MS = 5_000

// Pure and independently testable (vi.useFakeTimers()/vi.setSystemTime() drives `Date.now()`
// deterministically in tests, same technique lib/drive/upload.test.ts already uses for the progress
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
	// Omits `paused` — every newly added transfer starts unpaused, enforced here rather than trusted
	// to each call site (lib/drive/upload.ts's runUpload, lib/drive/download.ts's runDownload).
	add: (transfer: Omit<Transfer, "paused">) => void
	setProgress: (id: string, bytesTransferred: number) => void
	// Updates a transfer's total size after add() — every upload and single-file download already
	// knows its size upfront (the source File/DriveItem carries it), but a zip transfer's total isn't
	// known until the SDK's own progress callback reports it, and can keep growing as the recursive
	// walk discovers more files (lib/drive/download-zip.ts's runZipDownload adds the row at size 0 and
	// calls this on every throttled tick).
	setSize: (id: string, size: number) => void
	// Flips ONLY the paused flag — never touches status (paused is not a terminal state; see
	// Transfer["paused"]'s own comment). Backs the active-row pause/resume toggle
	// (lib/transfers/control.ts's pauseTransfer/resumeTransfer).
	setPaused: (id: string, paused: boolean) => void
	settle: (id: string, status: TerminalStatus, error?: ErrorDTO) => void
	remove: (id: string) => void
	// Drops every finished (non-active) row; active transfers are left untouched. Backs the
	// transfers panel's "clear finished" control.
	clearFinished: () => void
}

export const useTransfersStore = create<TransfersStore>(set => ({
	transfers: [],
	speedSamples: [],
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
			const transfers = state.transfers.map(transfer => (transfer.id === id ? { ...transfer, bytesTransferred } : transfer))
			const now = Date.now()
			let totalBytes = 0

			for (const transfer of transfers) {
				if (isActiveTransfer(transfer.status)) {
					totalBytes += transfer.bytesTransferred
				}
			}

			const speedSamples = [...state.speedSamples, { timestamp: now, totalBytes }].filter(
				sample => sample.timestamp >= now - SPEED_WINDOW_MS
			)

			return { transfers, speedSamples }
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

			return { transfers: capFinishedTransfers(transfers) }
		})
	},
	remove: id => {
		set(state => ({ transfers: state.transfers.filter(transfer => transfer.id !== id) }))
	},
	clearFinished: () => {
		set(state => ({ transfers: state.transfers.filter(transfer => isActiveTransfer(transfer.status)) }))
	}
}))

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
		transferred += transfer.bytesTransferred
		total += transfer.size
	}

	return {
		activeCount,
		percent: activeCount === 0 || total === 0 ? 0 : (transferred / total) * 100,
		speed: computeTransfersSpeed(speedSamples)
	}
}

// Selector hook, not a plain accessor — React-Compiler standing constraint: a component reads this
// store through a selector hook returning primitives/stable refs, never `.getState()` in render.
// useShallow keeps the returned object's IDENTITY stable across renders where neither field actually
// changed (mirrors directory-listing.tsx's own useShallow(state => state.selectedItems)), since
// computeTransfersAggregate otherwise returns a brand-new object on every store update. `percent` is
// 0-100, ready to feed straight into a progress bar — not a 0..1 ratio.
export function useTransfersAggregate(): { activeCount: number; percent: number; speed: number } {
	return useTransfersStore(useShallow(state => computeTransfersAggregate(state.transfers, state.speedSamples)))
}
