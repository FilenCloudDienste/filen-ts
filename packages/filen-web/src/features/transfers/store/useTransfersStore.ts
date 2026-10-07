import { useEffect } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { DriveItem } from "@/features/drive/lib/item"
import { clampedRatio, type DriveJobKind } from "@filen/shared"
import { withoutKey } from "@/lib/utils"

// A row's direction: an upload, a download, or one whole drive job (copy, compress, extract).
export type TransferDirection = "upload" | "download" | DriveJobKind

export type ActiveTransferStatus = "uploading" | "downloading" | "copying" | "compressing" | "extracting"

// The active status a drive job's row runs under.
export const JOB_ACTIVE_STATUS: Readonly<Record<DriveJobKind, ActiveTransferStatus>> = {
	copy: "copying",
	compress: "compressing",
	extract: "extracting"
}

export function isDriveJobDirection(direction: TransferDirection): direction is DriveJobKind {
	return direction === "copy" || direction === "compress" || direction === "extract"
}

// One row per in-flight or finished transfer, in-memory only (no persistence — mirrors
// useDriveStore's selection state, not a query). "upload" and "download" rows come from
// features/drive/lib/upload.ts's runUpload and features/drive/lib/download.ts's runDownload (a zip
// transfer is one row too — features/drive/lib/downloadZip.ts's runZipDownload); a drive job's row is
// one whole job (features/drive/lib/copy.ts, archiveJobs.ts), never one row per file it touches.
// "cancelled" is a real, if short-lived, status: a cancel path settles to it then immediately removes
// the row (mobile parity — no history entry for an aborted transfer), so it is never expected to render.
// "completedWithErrors" is a job that finished with some of its items failed.
export interface Transfer {
	id: string
	direction: TransferDirection
	name: string
	size: number
	bytesTransferred: number
	status: ActiveTransferStatus | "done" | "error" | "cancelled" | "completedWithErrors"
	// Suspended-in-place flag for an ACTIVE transfer — set via setPaused, never via settle. Never
	// implies a status change: a paused transfer keeps its active status (isActiveTransfer
	// stays true), just not currently receiving bytes/progress until resumed.
	paused: boolean
	// Present only once status is "error" — exactOptionalPropertyTypes forbids assigning `undefined`
	// to this key explicitly, so settle() below only ever spreads it in when actually provided.
	error?: ErrorDTO
	parentUuid: string | null
	startedAt: number
	// What the row's "Show in directory" reveals: a landed upload's own file, a compress job's archive, an
	// extract job's first created item.
	item?: DriveItem
	// The browser's download manager streams this one (the service-worker path): it can be cancelled,
	// never paused.
	browserManaged?: true
	// Waits for the page's one archive slot (an archive entry's download); a drive job's row reads its job.
	waitingForSlot?: true
	// The drive upload run this belongs to, which the target directory's listing shows while it runs.
	batch?: UploadBatchRef
}

// One drive upload run as the listing it targets shows it: a plain pick or drop of files, or one
// top-level directory of a directory upload (`directoryName`). Every transfer of the run holds the same
// object, so tagging one allocates nothing.
export interface UploadBatchRef {
	id: string
	// The directory whose listing shows the run, null for the root however the upload named it.
	parentUuid: string | null
	directoryName?: string
}

// A run's running totals, kept here rather than summed from its transfers: finished rows are capped and
// can be cleared, and a run's progress must not move backwards when one goes.
export interface UploadBatch {
	ref: UploadBatchRef
	// False once the run returned; only a directory run that ended with failures is kept then, until dismissed.
	running: boolean
	// A cancel from the listing: the run starts nothing more.
	cancelled: boolean
	// The files started and still counted (a cancelled one leaves the run), their size, and how many settled.
	files: number
	bytes: number
	settledFiles: number
	// Bytes moved for the counted files: a done file's whole size, a failed one's nothing.
	transferred: number
	failedBytes: number
	// Failed items, including those a directory run never started because their directory failed.
	failed: number
	error?: ErrorDTO
}

// Every terminal state settle() can drive a transfer to. Kept separate from Transfer["status"]
// (which also carries the ACTIVE states) so a call site can never accidentally settle a transfer to
// an active one.
export type TerminalStatus = "done" | "error" | "cancelled" | "completedWithErrors"

// The single "is this row still in flight" predicate — replaces every direct `status ===
// "uploading"` sentinel so every active status counts identically.
export function isActiveTransfer(status: Transfer["status"]): boolean {
	return status === "uploading" || status === "downloading" || status === "copying" || status === "compressing" || status === "extracting"
}

export function hasActiveTransfers(transfers: readonly Transfer[]): boolean {
	return transfers.some(transfer => isActiveTransfer(transfer.status))
}

export function hasActiveDriveJobs(transfers: readonly Transfer[]): boolean {
	return transfers.some(transfer => isDriveJobDirection(transfer.direction) && isActiveTransfer(transfer.status))
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

// Long enough that one chunk's worth of progress landing (progress arrives in bursts, one per finished
// chunk) moves the speed by a few percent rather than a fifth, which is what made the time left jump.
const SPEED_WINDOW_MS = 20_000
// A gap in progress longer than this is a stall, not the pause between two chunks: from then on the window
// ends at the clock, so a stalled transfer's speed falls off steadily instead of standing until its window
// empties.
const STALL_GRACE_MS = 3_000
// Less measured time than this says nothing honest about the speed yet.
const MIN_MEASURED_MS = 1_000

// Pure and independently testable (vi.useFakeTimers()/vi.setSystemTime() drives `Date.now()`
// deterministically in tests, same technique upload.test.ts already uses for the progress throttle).
// Bytes/sec across the window, from its earliest sample to its latest one (or the clock, once stalled).
// Reads 0 rather than a NaN/Infinity spike until enough has been measured.
export function computeTransfersSpeed(samples: readonly SpeedSample[], now: number = Date.now()): number {
	const windowStart = now - SPEED_WINDOW_MS
	const inWindow = samples.filter(sample => sample.timestamp >= windowStart)
	const first = inWindow[0]
	const last = inWindow[inWindow.length - 1]

	if (inWindow.length < 2 || first === undefined || last === undefined) {
		return 0
	}

	const elapsedMs = Math.max(last.timestamp, now - STALL_GRACE_MS) - first.timestamp

	if (elapsedMs < MIN_MEASURED_MS) {
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
	// time left. Dropped once the transfer settles or its window empties; a drive job's row reads its job instead.
	rowSpeedSamples: Readonly<Record<string, SpeedSample[]>>
	// Upload runs by id, insertion-ordered (string keys), and the same rolling window per run over its
	// cumulative bytes, for the listing's directory and summary rows.
	uploadBatches: Readonly<Record<string, UploadBatch>>
	batchSpeedSamples: Readonly<Record<string, SpeedSample[]>>
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
	// (features/transfers/lib/control.ts's setTransferPaused).
	setPaused: (id: string, paused: boolean) => void
	// setPaused for many rows in one update, so pause-all notifies subscribers once.
	setPausedMany: (ids: ReadonlySet<string>, paused: boolean) => void
	setWaitingForSlot: (id: string, waiting: boolean) => void
	settle: (id: string, status: TerminalStatus, error?: ErrorDTO) => void
	// `name` renames the row too, for a job whose item came out under another name than it asked for.
	setItem: (id: string, item: DriveItem, name?: string) => void
	remove: (id: string) => void
	// remove for many rows in one update.
	removeMany: (ids: ReadonlySet<string>) => void
	startUploadBatch: (ref: UploadBatchRef) => void
	// Items a directory run could not start: a directory it failed to create and everything under it.
	failUploadBatchItems: (id: string, count: number, error?: ErrorDTO) => void
	cancelUploadBatches: (ids: ReadonlySet<string>) => void
	endUploadBatch: (id: string) => void
	removeUploadBatches: (ids: ReadonlySet<string>) => void
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

// samplesSince over every window of a record, dropping the emptied ones; the same object when none aged out.
function samplesRecordSince(record: Readonly<Record<string, SpeedSample[]>>, windowStart: number): Readonly<Record<string, SpeedSample[]>> {
	let out = record

	for (const [id, samples] of Object.entries(record)) {
		const kept = samplesSince(samples, windowStart)

		if (kept !== samples) {
			out = kept.length === 0 ? withoutKey(out, id) : { ...out, [id]: kept }
		}
	}

	return out
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

export function hasSpeedSamples(state: Pick<TransfersStore, "speedSamples" | "rowSpeedSamples" | "batchSpeedSamples">): boolean {
	return state.speedSamples.length > 0 || Object.keys(state.rowSpeedSamples).length > 0 || Object.keys(state.batchSpeedSamples).length > 0
}

// Applies `update` to a run's totals; the same object when the run is gone.
function withBatch(
	batches: Readonly<Record<string, UploadBatch>>,
	id: string,
	update: (batch: UploadBatch) => UploadBatch
): Readonly<Record<string, UploadBatch>> {
	const batch = batches[id]

	return batch === undefined ? batches : { ...batches, [id]: update(batch) }
}

// A settling file's effect on its run: a done file counts whole, a failed one moves its size out of what
// is left to send, a cancelled one leaves the run.
function settledBatch(batch: UploadBatch, transfer: Transfer, status: TerminalStatus, error: ErrorDTO | undefined): UploadBatch {
	switch (status) {
		case "done":
			return {
				...batch,
				settledFiles: batch.settledFiles + 1,
				transferred: batch.transferred + Math.max(0, transfer.size - transfer.bytesTransferred)
			}
		case "cancelled":
			return {
				...batch,
				files: batch.files - 1,
				bytes: batch.bytes - transfer.size,
				transferred: batch.transferred - transfer.bytesTransferred
			}
		default:
			return {
				...batch,
				settledFiles: batch.settledFiles + 1,
				transferred: batch.transferred - transfer.bytesTransferred,
				failedBytes: batch.failedBytes + transfer.size,
				failed: batch.failed + 1,
				...(batch.error === undefined && error !== undefined ? { error } : {})
			}
	}
}

function withoutKeys<T>(record: Readonly<Record<string, T>>, ids: ReadonlySet<string>): Readonly<Record<string, T>> {
	let out = record

	for (const id of ids) {
		out = withoutKey(out, id)
	}

	return out
}

export const useTransfersStore = create<TransfersStore>((set, get) => ({
	transfers: [],
	speedSamples: [],
	rowSpeedSamples: {},
	uploadBatches: {},
	batchSpeedSamples: {},
	add: transfer => {
		set(state => {
			const transfers = [...state.transfers, { ...transfer, paused: false }]

			if (transfer.batch === undefined) {
				return { transfers }
			}

			return {
				transfers,
				uploadBatches: withBatch(state.uploadBatches, transfer.batch.id, batch => ({
					...batch,
					files: batch.files + 1,
					bytes: batch.bytes + transfer.size
				}))
			}
		})
	},
	setPaused: (id, paused) => {
		get().setPausedMany(new Set([id]), paused)
	},
	setPausedMany: (ids, paused) => {
		set(state => ({
			transfers: state.transfers.map(transfer => (ids.has(transfer.id) ? { ...transfer, paused } : transfer))
		}))
	},
	setWaitingForSlot: (id, waiting) => {
		set(state => {
			const target = state.transfers.find(transfer => transfer.id === id)

			if (target === undefined || (target.waitingForSlot === true) === waiting) {
				return state
			}

			return {
				transfers: state.transfers.map(transfer => {
					if (transfer !== target) {
						return transfer
					}

					const next: Transfer = { ...transfer, waitingForSlot: true }

					if (!waiting) {
						delete next.waitingForSlot
					}

					return next
				})
			}
		})
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
			const moved = Math.max(0, bytesTransferred - target.bytesTransferred)
			const totalBytes = (state.speedSamples.at(-1)?.totalBytes ?? 0) + moved
			const windowStart = now - SPEED_WINDOW_MS
			const speedSamples = samplesSince([...state.speedSamples, { timestamp: now, totalBytes }], windowStart)

			if (isDriveJobDirection(target.direction)) {
				return { transfers, speedSamples }
			}

			const rowSamples = samplesSince(
				[...(state.rowSpeedSamples[id] ?? []), { timestamp: now, totalBytes: bytesTransferred }],
				windowStart
			)
			const rowSpeedSamples = { ...state.rowSpeedSamples, [id]: rowSamples }
			const batchId = target.batch?.id

			if (batchId === undefined || state.uploadBatches[batchId] === undefined) {
				return { transfers, speedSamples, rowSpeedSamples }
			}

			const batchSamples = state.batchSpeedSamples[batchId] ?? []
			const batchTotal = (batchSamples.at(-1)?.totalBytes ?? 0) + moved

			return {
				transfers,
				speedSamples,
				rowSpeedSamples,
				uploadBatches: withBatch(state.uploadBatches, batchId, batch => ({
					...batch,
					transferred: batch.transferred + bytesTransferred - target.bytesTransferred
				})),
				batchSpeedSamples: {
					...state.batchSpeedSamples,
					[batchId]: samplesSince([...batchSamples, { timestamp: now, totalBytes: batchTotal }], windowStart)
				}
			}
		})
	},
	setSize: (id, size) => {
		set(state => ({
			transfers: state.transfers.map(transfer => (transfer.id === id ? { ...transfer, size } : transfer))
		}))
	},
	settle: (id, status, error) => {
		set(state => {
			const target = state.transfers.find(transfer => transfer.id === id)
			const transfers = state.transfers.map(transfer =>
				transfer === target ? (error === undefined ? { ...transfer, status } : { ...transfer, status, error }) : transfer
			)
			// Only the first settle of an active row counts toward its run.
			const batchId = target !== undefined && isActiveTransfer(target.status) ? target.batch?.id : undefined
			const uploadBatches =
				target === undefined || batchId === undefined
					? state.uploadBatches
					: withBatch(state.uploadBatches, batchId, batch => settledBatch(batch, target, status, error))

			// "cancelled" never joins history — every caller removes the row immediately after settling it
			// (runDownload/runZipDownload/runUpload's own Cancelled branch) — so it must never count toward
			// the finished cap either, or that transient row can evict an OLDER, still-legitimate finished
			// row an instant before it is itself removed.
			return {
				transfers: status === "cancelled" ? transfers : capFinishedTransfers(transfers),
				rowSpeedSamples: rowSamplesOfActive(state.rowSpeedSamples, transfers),
				uploadBatches
			}
		})
	},
	setItem: (id, item, name) => {
		set(state => ({
			transfers: state.transfers.map(transfer =>
				transfer.id === id ? (name === undefined ? { ...transfer, item } : { ...transfer, item, name }) : transfer
			)
		}))
	},
	remove: id => {
		get().removeMany(new Set([id]))
	},
	removeMany: ids => {
		set(state => ({
			transfers: state.transfers.filter(transfer => !ids.has(transfer.id)),
			rowSpeedSamples: withoutKeys(state.rowSpeedSamples, ids)
		}))
	},
	startUploadBatch: ref => {
		set(state => ({
			uploadBatches: {
				...state.uploadBatches,
				[ref.id]: {
					ref,
					running: true,
					cancelled: false,
					files: 0,
					bytes: 0,
					settledFiles: 0,
					transferred: 0,
					failedBytes: 0,
					failed: 0
				}
			}
		}))
	},
	failUploadBatchItems: (id, count, error) => {
		set(state => ({
			uploadBatches: withBatch(state.uploadBatches, id, batch => ({
				...batch,
				failed: batch.failed + count,
				...(batch.error === undefined && error !== undefined ? { error } : {})
			}))
		}))
	},
	cancelUploadBatches: ids => {
		set(state => {
			let uploadBatches = state.uploadBatches

			for (const id of ids) {
				uploadBatches = withBatch(uploadBatches, id, batch => ({ ...batch, cancelled: true }))
			}

			return { uploadBatches }
		})
	},
	endUploadBatch: id => {
		set(state => {
			const batch = state.uploadBatches[id]

			if (batch === undefined) {
				return state
			}

			// A plain run's failures stay as its own failed rows; a directory run's only as the run.
			if (batch.ref.directoryName !== undefined && batch.failed > 0 && !batch.cancelled) {
				return { uploadBatches: { ...state.uploadBatches, [id]: { ...batch, running: false } } }
			}

			return { uploadBatches: withoutKey(state.uploadBatches, id) }
		})
	},
	removeUploadBatches: ids => {
		set(state => ({
			uploadBatches: withoutKeys(state.uploadBatches, ids),
			batchSpeedSamples: withoutKeys(state.batchSpeedSamples, ids)
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
			const rowSpeedSamples = samplesRecordSince(state.rowSpeedSamples, windowStart)
			const batchSpeedSamples = samplesRecordSince(state.batchSpeedSamples, windowStart)

			return speedSamples === state.speedSamples &&
				rowSpeedSamples === state.rowSpeedSamples &&
				batchSpeedSamples === state.batchSpeedSamples
				? state
				: { speedSamples, rowSpeedSamples, batchSpeedSamples }
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
