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
// one whole job (features/drive/lib/copy.ts, archiveJobs.ts), never one row per file it touches, and so
// is each top-level directory of a directory upload (its run's row, see isDirectoryRunRow): only a file
// of it that failed gets a row of its own.
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
	// extract job's first created item, a directory upload's top-level directory.
	item?: DriveItem
	// The browser's download manager streams this one (the service-worker path): it can be cancelled,
	// never paused.
	browserManaged?: true
	// Waits for the page's one archive slot (an archive entry's download); a drive job's row reads its job.
	waitingForSlot?: true
	// The drive upload run this belongs to, which the target directory's listing shows while it runs.
	batch?: UploadBatchRef
	// A finished directory run's failed items, kept on its row: the run itself can be dismissed first.
	failedItems?: number
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
	// A dropped directory still being walked: `files` and `bytes` are what the walk found so far.
	scanning?: true
	// The files the run holds and still counts (sized when it starts; a cancelled one leaves the run), their
	// size, and how many settled.
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

// What a run is sized at when it starts.
export interface UploadBatchTotals {
	files: number
	bytes: number
}

// A directory run's own row: one per top-level directory, under its run's id.
export function isDirectoryRunRow(transfer: Transfer): boolean {
	return transfer.batch?.id === transfer.id
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

// ---------------------------------------------------------------------------
// The rows' index: positions by id and the aggregates the subscribers read, so a selector costs O(1) (or
// O(drive jobs)) rather than a pass over thousands of rows on every write. Cached by the `transfers`
// array's identity: the store's actions carry it from one array to the next, and any other array (a
// test's setState) is indexed once, on its first read.
// ---------------------------------------------------------------------------

// One directory's listing units (pendingUploads.logic.ts), by row id in start order.
export interface ParentUnits {
	// Plain uploads still uploading, and the failed ones.
	uploads: Set<string>
	failed: Set<string>
	// Drive jobs still running.
	jobs: Set<string>
}

export interface TransfersIndex {
	// Row id -> position. Rows only ever append and a removal leaves the later positions too high, so a
	// stale one is corrected by walking down from it (positionOf).
	positions: Map<string, number>
	activeCount: number
	activeJobs: number
	// Over the active rows of known size: a zip still walking its tree has no share of the whole.
	activeSize: number
	activeTransferred: number
	// Rows that failed, wholly or in part.
	failedCount: number
	// Keyed by the listing's parent, null for the root.
	units: Map<string | null, ParentUnits>
}

const indexCache = new WeakMap<readonly Transfer[], TransfersIndex>()

function unitOf(transfer: Transfer): { parentUuid: string | null; kind: keyof ParentUnits } | null {
	if (isDriveJobDirection(transfer.direction)) {
		// A drive job's row names its destination, null for the root, as an upload run's does.
		return isActiveTransfer(transfer.status) ? { parentUuid: transfer.parentUuid, kind: "jobs" } : null
	}

	// A directory run is its run's unit, and a failed file of it is reported by that run.
	if (transfer.batch === undefined || transfer.batch.directoryName !== undefined) {
		return null
	}

	if (transfer.status === "uploading") {
		return { parentUuid: transfer.batch.parentUuid, kind: "uploads" }
	}

	return transfer.status === "error" ? { parentUuid: transfer.batch.parentUuid, kind: "failed" } : null
}

function accountUnit(index: TransfersIndex, transfer: Transfer, sign: 1 | -1): void {
	const unit = unitOf(transfer)

	if (unit === null) {
		return
	}

	let units = index.units.get(unit.parentUuid)

	if (sign === 1) {
		if (units === undefined) {
			units = { uploads: new Set(), failed: new Set(), jobs: new Set() }

			index.units.set(unit.parentUuid, units)
		}

		units[unit.kind].add(transfer.id)

		return
	}

	if (units === undefined) {
		return
	}

	units[unit.kind].delete(transfer.id)

	if (units.uploads.size === 0 && units.failed.size === 0 && units.jobs.size === 0) {
		index.units.delete(unit.parentUuid)
	}
}

function accountTotals(index: TransfersIndex, transfer: Transfer, sign: 1 | -1): void {
	if (isActiveTransfer(transfer.status)) {
		index.activeCount += sign

		if (isDriveJobDirection(transfer.direction)) {
			index.activeJobs += sign
		}

		if (transfer.size > 0) {
			index.activeSize += sign * transfer.size
			index.activeTransferred += sign * transfer.bytesTransferred
		}
	} else if (transfer.status === "error" || transfer.status === "completedWithErrors") {
		index.failedCount += sign
	}
}

function buildIndex(transfers: readonly Transfer[]): TransfersIndex {
	const index: TransfersIndex = {
		positions: new Map(),
		activeCount: 0,
		activeJobs: 0,
		activeSize: 0,
		activeTransferred: 0,
		failedCount: 0,
		units: new Map()
	}

	transfers.forEach((transfer, position) => {
		index.positions.set(transfer.id, position)
		accountTotals(index, transfer, 1)
		accountUnit(index, transfer, 1)
	})

	return index
}

export function transfersIndexOf(transfers: readonly Transfer[]): TransfersIndex {
	let index = indexCache.get(transfers)

	if (index === undefined) {
		index = buildIndex(transfers)

		indexCache.set(transfers, index)
	}

	return index
}

function findPosition(transfers: readonly Transfer[], positions: Map<string, number>, id: string): number {
	const known = positions.get(id)

	if (known === undefined) {
		return -1
	}

	for (let position = Math.min(known, transfers.length - 1); position >= 0; position--) {
		if (transfers[position]?.id === id) {
			positions.set(id, position)

			return position
		}
	}

	return -1
}

// A row's position, -1 for an unknown id.
export function positionOf(transfers: readonly Transfer[], id: string): number {
	return findPosition(transfers, transfersIndexOf(transfers).positions, id)
}

export function transferById(transfers: readonly Transfer[], id: string): Transfer | undefined {
	const position = positionOf(transfers, id)

	return position === -1 ? undefined : transfers[position]
}

// One write's rows and index, copied on its first change: the counters are copied, the maps shared and
// changed in place, and the previous array leaves the cache so a late read of it is indexed afresh rather
// than through maps that moved on. Nothing changed, nothing is copied.
class RowsDraft {
	private readonly source: readonly Transfer[]
	private copy: { rows: Transfer[]; index: TransfersIndex } | undefined
	// A bulk removal shifts too many positions to correct lazily: the index is rebuilt on commit.
	private reindex = false

	constructor(source: readonly Transfer[]) {
		this.source = source
	}

	get rows(): readonly Transfer[] {
		return this.copy?.rows ?? this.source
	}

	get changed(): boolean {
		return this.copy !== undefined
	}

	private writable(): { rows: Transfer[]; index: TransfersIndex } {
		if (this.copy === undefined) {
			this.copy = { rows: this.source.slice(), index: { ...transfersIndexOf(this.source) } }

			indexCache.delete(this.source)
		}

		return this.copy
	}

	position(id: string): number {
		return findPosition(this.rows, (this.copy?.index ?? transfersIndexOf(this.source)).positions, id)
	}

	get(id: string): Transfer | undefined {
		const position = this.position(id)

		return position === -1 ? undefined : this.rows[position]
	}

	append(transfer: Transfer): void {
		const { rows, index } = this.writable()

		rows.push(transfer)
		index.positions.set(transfer.id, rows.length - 1)
		accountTotals(index, transfer, 1)
		accountUnit(index, transfer, 1)
	}

	replace(position: number, next: Transfer): void {
		const { rows, index } = this.writable()
		const prev = rows[position]

		if (prev === undefined) {
			return
		}

		accountTotals(index, prev, -1)
		accountTotals(index, next, 1)

		// Only a row that changes unit moves between the sets, so a progress tick keeps the start order.
		const prevUnit = unitOf(prev)
		const nextUnit = unitOf(next)

		if (prevUnit?.kind !== nextUnit?.kind || prevUnit?.parentUuid !== nextUnit?.parentUuid) {
			accountUnit(index, prev, -1)
			accountUnit(index, next, 1)
		}

		rows[position] = next
	}

	removeAt(position: number): Transfer | undefined {
		const { rows, index } = this.writable()
		const [removed] = rows.splice(position, 1)

		if (removed !== undefined) {
			index.positions.delete(removed.id)
			accountTotals(index, removed, -1)
			accountUnit(index, removed, -1)
		}

		return removed
	}

	// Keeps the rows `keep` passes, in order; returns the others.
	filter(keep: (transfer: Transfer) => boolean): Transfer[] {
		if (this.rows.every(keep)) {
			return []
		}

		const { rows } = this.writable()
		const removed: Transfer[] = []
		let kept = 0

		for (const transfer of rows) {
			if (keep(transfer)) {
				rows[kept++] = transfer
			} else {
				removed.push(transfer)
			}
		}

		rows.length = kept
		this.reindex = true

		return removed
	}

	// Drops the oldest finished rows past the cap (capFinishedTransfers' rule); returns their ids.
	capFinished(): string[] {
		const finished = this.rows.length - (this.copy?.index ?? transfersIndexOf(this.source)).activeCount
		const excess = finished - MAX_FINISHED_TRANSFERS

		if (excess <= 0) {
			return []
		}

		if (excess === 1) {
			const position = this.rows.findIndex(transfer => !isActiveTransfer(transfer.status))
			const removed = position === -1 ? undefined : this.removeAt(position)

			return removed === undefined ? [] : [removed.id]
		}

		const dropped = new Set<string>()

		for (const transfer of this.rows) {
			if (dropped.size === excess) {
				break
			}

			if (!isActiveTransfer(transfer.status)) {
				dropped.add(transfer.id)
			}
		}

		this.filter(transfer => !dropped.has(transfer.id))

		return [...dropped]
	}

	// The write's `transfers`, or nothing when no row changed.
	result(): { transfers?: Transfer[] } {
		if (this.copy === undefined) {
			return {}
		}

		indexCache.set(this.copy.rows, this.reindex ? buildIndex(this.copy.rows) : this.copy.index)

		return { transfers: this.copy.rows }
	}
}

export function hasActiveTransfers(transfers: readonly Transfer[]): boolean {
	return transfersIndexOf(transfers).activeCount > 0
}

export function hasActiveDriveJobs(transfers: readonly Transfer[]): boolean {
	return transfersIndexOf(transfers).activeJobs > 0
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

// A directory run's file on its way: it has no row, its progress moves its run's.
export interface RunFileStart {
	id: string
	batchId: string
	size: number
	// The size its run was sized with for it (startUploadBatch), which differs from `size` once a HEIC file
	// was converted; a file the run was not sized for leaves it out and adds itself.
	counted?: number
}

// The row a failed file of a directory run gets, so it can be seen.
export interface RunFileFailure {
	name: string
	parentUuid: string | null
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
	// A row its run was sized for passes `counted`, the size it was counted at; without it the run grows by it.
	add: (transfer: Omit<Transfer, "paused">, counted?: number) => void
	// add for many rows, each counted at its own size by its run, in one update.
	addMany: (transfers: readonly Omit<Transfer, "paused">[]) => void
	setProgress: (id: string, bytesTransferred: number) => void
	// setProgress for every transfer one progress batch of the SDK worker names (progressChannel.ts), in
	// one update: rows, and the files of directory runs.
	setProgressMany: (bytesById: Readonly<Record<string, number>>) => void
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
	// Starts a run sized at `totals`, or sizes one started while its directory was still being walked
	// (`scanning`). A directory run gets its row.
	startUploadBatch: (ref: UploadBatchRef, totals?: UploadBatchTotals, options?: { scanning: boolean }) => void
	// What the walks of scanning runs found so far, by run id, in one update.
	updateUploadBatchScans: (found: ReadonlyMap<string, UploadBatchTotals>) => void
	// Items a directory run could not start: a directory it failed to create and everything under it.
	// `skippedBytes` is the size of the files among them, which the run was sized with.
	failUploadBatchItems: (id: string, count: number, error?: ErrorDTO, skippedBytes?: number) => void
	cancelUploadBatches: (ids: ReadonlySet<string>) => void
	endUploadBatch: (id: string) => void
	removeUploadBatches: (ids: ReadonlySet<string>) => void
	// Runs that never got to upload (their walk failed, or the quota blocked them): they go with their rows.
	discardUploadBatches: (ids: ReadonlySet<string>) => void
	// A directory run's file starting and settling. A failed one gets a row of its own; no other does.
	startRunFile: (file: RunFileStart) => void
	settleRunFile: (id: string, status: "done" | "error" | "cancelled", error?: ErrorDTO, failure?: RunFileFailure) => void
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

// Samples closer together than this say nothing more about the speed: a later one moves the last sample's
// bytes instead of growing the window.
const MIN_SAMPLE_GAP_MS = 100

function appendSample(samples: SpeedSample[] | undefined, timestamp: number, totalBytes: number): SpeedSample[] {
	const last = samples?.at(-1)

	if (samples !== undefined && last !== undefined && timestamp - last.timestamp < MIN_SAMPLE_GAP_MS) {
		return samplesSince([...samples.slice(0, -1), { timestamp: last.timestamp, totalBytes }], timestamp - SPEED_WINDOW_MS)
	}

	return samplesSince([...(samples ?? []), { timestamp, totalBytes }], timestamp - SPEED_WINDOW_MS)
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
function settledBatch(
	batch: UploadBatch,
	file: Pick<Transfer, "size" | "bytesTransferred">,
	status: TerminalStatus,
	error: ErrorDTO | undefined
): UploadBatch {
	switch (status) {
		case "done":
			return {
				...batch,
				settledFiles: batch.settledFiles + 1,
				transferred: batch.transferred + Math.max(0, file.size - file.bytesTransferred)
			}
		case "cancelled":
			return {
				...batch,
				files: batch.files - 1,
				bytes: batch.bytes - file.size,
				transferred: batch.transferred - file.bytesTransferred
			}
		default:
			return {
				...batch,
				settledFiles: batch.settledFiles + 1,
				transferred: batch.transferred - file.bytesTransferred,
				failedBytes: batch.failedBytes + file.size,
				failed: batch.failed + 1,
				...(batch.error === undefined && error !== undefined ? { error } : {})
			}
	}
}

// A run grown by a file it was not sized for, or re-sized for one whose size changed since.
function countedBatch(batch: UploadBatch, size: number, counted: number | undefined): UploadBatch {
	return counted === undefined
		? { ...batch, files: batch.files + 1, bytes: batch.bytes + size }
		: { ...batch, bytes: batch.bytes + size - counted }
}

function withoutKeys<T>(record: Readonly<Record<string, T>>, ids: Iterable<string>): Readonly<Record<string, T>> {
	let out = record

	for (const id of ids) {
		out = withoutKey(out, id)
	}

	return out
}

// A directory run's row mirrors its run's totals: the bytes still counted, and how many of them moved.
function syncRunRow(draft: RowsDraft, batch: UploadBatch): void {
	const position = draft.position(batch.ref.id)
	const row = draft.rows[position]

	if (row === undefined || !isActiveTransfer(row.status)) {
		return
	}

	const size = batch.bytes - batch.failedBytes

	if (row.size !== size || row.bytesTransferred !== batch.transferred) {
		draft.replace(position, { ...row, size, bytesTransferred: batch.transferred })
	}
}

// The files of directory runs on their way, which have no row: what each moved, and its run. Not state, as
// nothing renders them; every change to one lands on its run in the same update.
const runFiles = new Map<string, { batchId: string; size: number; bytesTransferred: number; startedAt: number }>()

export const useTransfersStore = create<TransfersStore>((set, get) => ({
	transfers: [],
	speedSamples: [],
	rowSpeedSamples: {},
	uploadBatches: {},
	batchSpeedSamples: {},
	add: (transfer, counted) => {
		set(state => {
			const draft = new RowsDraft(state.transfers)

			draft.append({ ...transfer, paused: false })

			if (transfer.batch === undefined) {
				return draft.result()
			}

			return {
				...draft.result(),
				uploadBatches: withBatch(state.uploadBatches, transfer.batch.id, batch => countedBatch(batch, transfer.size, counted))
			}
		})
	},
	addMany: transfers => {
		if (transfers.length === 0) {
			return
		}

		set(state => {
			const draft = new RowsDraft(state.transfers)

			for (const transfer of transfers) {
				draft.append({ ...transfer, paused: false })
			}

			return draft.result()
		})
	},
	setPaused: (id, paused) => {
		get().setPausedMany(new Set([id]), paused)
	},
	setPausedMany: (ids, paused) => {
		set(state => {
			const draft = new RowsDraft(state.transfers)

			for (const id of ids) {
				const position = draft.position(id)
				const transfer = draft.rows[position]

				if (transfer !== undefined && transfer.paused !== paused) {
					draft.replace(position, { ...transfer, paused })
				}
			}

			return draft.changed ? draft.result() : state
		})
	},
	setWaitingForSlot: (id, waiting) => {
		set(state => {
			const draft = new RowsDraft(state.transfers)
			const position = draft.position(id)
			const target = draft.rows[position]

			if (target === undefined || (target.waitingForSlot === true) === waiting) {
				return state
			}

			const next: Transfer = { ...target, waitingForSlot: true }

			if (!waiting) {
				delete next.waitingForSlot
			}

			draft.replace(position, next)

			return draft.result()
		})
	},
	setProgress: (id, bytesTransferred) => {
		get().setProgressMany({ [id]: bytesTransferred })
	},
	setProgressMany: bytesById => {
		set(state => {
			const draft = new RowsDraft(state.transfers)
			const now = Date.now()
			let rowSpeedSamples: Record<string, SpeedSample[]> | undefined
			// Per run: the bytes it moved (a restart moves none) and how far its total went, either way.
			const runs = new Map<string, { moved: number; delta: number }>()
			let moved = 0
			let reported = false

			function moveRun(batchId: string, fileMoved: number, delta: number): void {
				const run = runs.get(batchId) ?? { moved: 0, delta: 0 }

				run.moved += fileMoved
				run.delta += delta

				runs.set(batchId, run)
			}

			for (const id in bytesById) {
				const bytesTransferred = bytesById[id]

				if (bytesTransferred === undefined) {
					continue
				}

				const file = runFiles.get(id)

				if (file !== undefined) {
					// A restarted transfer reporting fewer bytes moved none.
					const fileMoved = Math.max(0, bytesTransferred - file.bytesTransferred)

					moveRun(file.batchId, fileMoved, bytesTransferred - file.bytesTransferred)
					moved += fileMoved
					reported = true
					file.bytesTransferred = bytesTransferred

					continue
				}

				const position = draft.position(id)
				const target = draft.rows[position]

				// A late tick can land after its transfer settled or was removed: nothing to update, and a
				// sample written for it would never be dropped.
				if (target === undefined || !isActiveTransfer(target.status)) {
					continue
				}

				draft.replace(position, { ...target, bytesTransferred })

				const rowMoved = Math.max(0, bytesTransferred - target.bytesTransferred)

				moved += rowMoved
				reported = true

				if (isDriveJobDirection(target.direction)) {
					continue
				}

				rowSpeedSamples ??= { ...state.rowSpeedSamples }
				rowSpeedSamples[id] = appendSample(rowSpeedSamples[id], now, bytesTransferred)

				const batchId = target.batch?.id

				if (batchId !== undefined) {
					moveRun(batchId, rowMoved, bytesTransferred - target.bytesTransferred)
				}
			}

			if (!reported) {
				return state
			}

			const update: Partial<TransfersStore> = {
				speedSamples: appendSample(state.speedSamples, now, (state.speedSamples.at(-1)?.totalBytes ?? 0) + moved)
			}
			let uploadBatches: Record<string, UploadBatch> | undefined
			let batchSpeedSamples: Record<string, SpeedSample[]> | undefined

			for (const [batchId, run] of runs) {
				const batch = state.uploadBatches[batchId]

				if (batch === undefined) {
					continue
				}

				const next = { ...batch, transferred: batch.transferred + run.delta }

				uploadBatches ??= { ...state.uploadBatches }
				uploadBatches[batchId] = next
				batchSpeedSamples ??= { ...state.batchSpeedSamples }
				batchSpeedSamples[batchId] = appendSample(
					batchSpeedSamples[batchId],
					now,
					(batchSpeedSamples[batchId]?.at(-1)?.totalBytes ?? 0) + run.moved
				)

				// A directory run's row moves with its files and keeps their window as its own.
				if (batch.ref.directoryName !== undefined && draft.position(batchId) !== -1) {
					syncRunRow(draft, next)

					rowSpeedSamples ??= { ...state.rowSpeedSamples }
					rowSpeedSamples[batchId] = appendSample(rowSpeedSamples[batchId], now, next.transferred)
				}
			}

			return {
				...update,
				...draft.result(),
				...(rowSpeedSamples === undefined ? {} : { rowSpeedSamples }),
				...(uploadBatches === undefined ? {} : { uploadBatches }),
				...(batchSpeedSamples === undefined ? {} : { batchSpeedSamples })
			}
		})
	},
	setSize: (id, size) => {
		set(state => {
			const draft = new RowsDraft(state.transfers)
			const position = draft.position(id)
			const target = draft.rows[position]

			if (target === undefined) {
				return state
			}

			draft.replace(position, { ...target, size })

			return draft.result()
		})
	},
	settle: (id, status, error) => {
		set(state => {
			const draft = new RowsDraft(state.transfers)
			const position = draft.position(id)
			const target = draft.rows[position]

			if (target === undefined) {
				return state
			}

			draft.replace(position, error === undefined ? { ...target, status } : { ...target, status, error })

			// Only the first settle of an active row counts toward its run.
			const batchId = isActiveTransfer(target.status) ? target.batch?.id : undefined
			const uploadBatches =
				batchId === undefined
					? state.uploadBatches
					: withBatch(state.uploadBatches, batchId, batch => settledBatch(batch, target, status, error))

			// "cancelled" never joins history — every caller removes the row immediately after settling it
			// (runDownload/runZipDownload/runUpload's own Cancelled branch) — so it must never count toward
			// the finished cap either, or that transient row can evict an OLDER, still-legitimate finished
			// row an instant before it is itself removed.
			const evicted = status === "cancelled" ? [] : draft.capFinished()

			return {
				...draft.result(),
				rowSpeedSamples: withoutKeys(state.rowSpeedSamples, [id, ...evicted]),
				uploadBatches
			}
		})
	},
	setItem: (id, item, name) => {
		set(state => {
			const draft = new RowsDraft(state.transfers)
			const position = draft.position(id)
			const target = draft.rows[position]

			if (target === undefined) {
				return state
			}

			draft.replace(position, name === undefined ? { ...target, item } : { ...target, item, name })

			return draft.result()
		})
	},
	remove: id => {
		get().removeMany(new Set([id]))
	},
	removeMany: ids => {
		set(state => {
			const draft = new RowsDraft(state.transfers)

			if (ids.size === 1) {
				for (const id of ids) {
					const position = draft.position(id)

					if (position !== -1) {
						draft.removeAt(position)
					}
				}
			} else {
				draft.filter(transfer => !ids.has(transfer.id))
			}

			return { ...draft.result(), rowSpeedSamples: withoutKeys(state.rowSpeedSamples, ids) }
		})
	},
	startUploadBatch: (ref, totals = { files: 0, bytes: 0 }, options) => {
		set(state => {
			const prev = state.uploadBatches[ref.id]
			const batch: UploadBatch = {
				...(prev ?? { ref, running: true, cancelled: false, settledFiles: 0, transferred: 0, failedBytes: 0, failed: 0 }),
				files: totals.files,
				bytes: totals.bytes
			}

			if (options?.scanning === true) {
				batch.scanning = true
			} else {
				delete batch.scanning
			}

			const uploadBatches = { ...state.uploadBatches, [ref.id]: batch }

			if (ref.directoryName === undefined) {
				return { uploadBatches }
			}

			const draft = new RowsDraft(state.transfers)

			// A run cancelled while it was walked lost its row for good.
			if (draft.position(ref.id) === -1 && !batch.cancelled) {
				draft.append({
					id: ref.id,
					direction: "upload",
					name: ref.directoryName,
					size: batch.bytes,
					bytesTransferred: 0,
					status: "uploading",
					paused: false,
					parentUuid: ref.parentUuid,
					startedAt: Date.now(),
					batch: ref
				})
			} else {
				syncRunRow(draft, batch)
			}

			return { uploadBatches, ...draft.result() }
		})
	},
	updateUploadBatchScans: found => {
		set(state => {
			const uploadBatches = { ...state.uploadBatches }
			const draft = new RowsDraft(state.transfers)

			let changed = false

			for (const [id, totals] of found) {
				const batch = uploadBatches[id]

				// A cancelled run has no row left to show what its walk found.
				if (batch?.scanning === true && !batch.cancelled && (batch.files !== totals.files || batch.bytes !== totals.bytes)) {
					const next = { ...batch, files: totals.files, bytes: totals.bytes }

					uploadBatches[id] = next
					changed = true
					syncRunRow(draft, next)
				}
			}

			return changed ? { uploadBatches, ...draft.result() } : state
		})
	},
	failUploadBatchItems: (id, count, error, skippedBytes) => {
		set(state => {
			const batch = state.uploadBatches[id]

			if (batch === undefined) {
				return state
			}

			const next: UploadBatch = {
				...batch,
				failed: batch.failed + count,
				...(skippedBytes === undefined
					? {}
					: { settledFiles: batch.settledFiles + count, failedBytes: batch.failedBytes + skippedBytes }),
				...(batch.error === undefined && error !== undefined ? { error } : {})
			}
			const draft = new RowsDraft(state.transfers)

			syncRunRow(draft, next)

			return { uploadBatches: { ...state.uploadBatches, [id]: next }, ...draft.result() }
		})
	},
	cancelUploadBatches: ids => {
		set(state => {
			let uploadBatches = state.uploadBatches
			// A run still being walked has nothing to abort: its row goes now rather than once the walk ends.
			const scanningRows = new Set<string>()

			for (const id of ids) {
				const batch = uploadBatches[id]

				if (batch?.scanning === true && batch.ref.directoryName !== undefined) {
					scanningRows.add(id)
				}

				uploadBatches = withBatch(uploadBatches, id, running => ({ ...running, cancelled: true }))
			}

			if (scanningRows.size === 0) {
				return { uploadBatches }
			}

			const draft = new RowsDraft(state.transfers)

			draft.filter(transfer => !scanningRows.has(transfer.id))

			return { uploadBatches, ...draft.result() }
		})
	},
	endUploadBatch: id => {
		set(state => {
			const batch = state.uploadBatches[id]

			if (batch === undefined) {
				return state
			}

			const directoryRun = batch.ref.directoryName !== undefined
			// A plain run's failures stay as its own failed rows; a directory run's only as the run.
			const uploadBatches =
				directoryRun && batch.failed > 0 && !batch.cancelled
					? { ...state.uploadBatches, [id]: { ...batch, running: false } }
					: withoutKey(state.uploadBatches, id)

			if (!directoryRun) {
				return { uploadBatches }
			}

			// The run's row settles with it; a cancelled one leaves no history, as no cancelled transfer does.
			const draft = new RowsDraft(state.transfers)
			const position = draft.position(id)
			const row = draft.rows[position]
			let evicted: string[] = []

			if (row !== undefined && batch.cancelled) {
				draft.removeAt(position)
			} else if (row !== undefined && isActiveTransfer(row.status)) {
				const size = batch.bytes - batch.failedBytes
				const failed = batch.failed > 0

				draft.replace(position, {
					...row,
					size,
					bytesTransferred: failed ? batch.transferred : size,
					status: failed ? "completedWithErrors" : "done",
					...(failed ? { failedItems: batch.failed } : {}),
					...(batch.error === undefined ? {} : { error: batch.error })
				})

				evicted = draft.capFinished()
			}

			return { uploadBatches, ...draft.result(), rowSpeedSamples: withoutKeys(state.rowSpeedSamples, [id, ...evicted]) }
		})
	},
	removeUploadBatches: ids => {
		set(state => ({
			uploadBatches: withoutKeys(state.uploadBatches, ids),
			batchSpeedSamples: withoutKeys(state.batchSpeedSamples, ids)
		}))
	},
	discardUploadBatches: ids => {
		set(state => {
			const draft = new RowsDraft(state.transfers)

			draft.filter(transfer => !ids.has(transfer.id))

			return {
				...draft.result(),
				uploadBatches: withoutKeys(state.uploadBatches, ids),
				batchSpeedSamples: withoutKeys(state.batchSpeedSamples, ids),
				rowSpeedSamples: withoutKeys(state.rowSpeedSamples, ids)
			}
		})
	},
	startRunFile: ({ id, batchId, size, counted }) => {
		runFiles.set(id, { batchId, size, bytesTransferred: 0, startedAt: Date.now() })

		// A file its run was sized for exactly changes nothing anybody sees: no write.
		if (counted === size) {
			return
		}

		set(state => {
			const batch = state.uploadBatches[batchId]

			if (batch === undefined) {
				return state
			}

			const next = countedBatch(batch, size, counted)
			const draft = new RowsDraft(state.transfers)

			syncRunRow(draft, next)

			return { uploadBatches: { ...state.uploadBatches, [batchId]: next }, ...draft.result() }
		})
	},
	settleRunFile: (id, status, error, failure) => {
		const file = runFiles.get(id)

		if (file === undefined) {
			return
		}

		runFiles.delete(id)

		set(state => {
			const batch = state.uploadBatches[file.batchId]
			const draft = new RowsDraft(state.transfers)
			let uploadBatches = state.uploadBatches
			let evicted: string[] = []
			const samples: Partial<TransfersStore> = {}

			if (batch !== undefined) {
				const next = settledBatch(batch, file, status, error)

				uploadBatches = { ...uploadBatches, [file.batchId]: next }

				syncRunRow(draft, next)

				// A done file's last bytes land here rather than in a progress batch of their own (the worker
				// drops a run file's last count), so the speed windows count them too.
				const moved = status === "done" ? Math.max(0, file.size - file.bytesTransferred) : 0

				if (moved > 0) {
					const now = Date.now()

					samples.speedSamples = appendSample(state.speedSamples, now, (state.speedSamples.at(-1)?.totalBytes ?? 0) + moved)
					samples.batchSpeedSamples = {
						...state.batchSpeedSamples,
						[file.batchId]: appendSample(
							state.batchSpeedSamples[file.batchId],
							now,
							(state.batchSpeedSamples[file.batchId]?.at(-1)?.totalBytes ?? 0) + moved
						)
					}

					if (draft.position(file.batchId) !== -1) {
						samples.rowSpeedSamples = {
							...state.rowSpeedSamples,
							[file.batchId]: appendSample(state.rowSpeedSamples[file.batchId], now, next.transferred)
						}
					}
				}
			}

			if (status === "error" && failure !== undefined) {
				draft.append({
					id,
					direction: "upload",
					name: failure.name,
					size: file.size,
					bytesTransferred: file.bytesTransferred,
					status: "error",
					paused: false,
					parentUuid: failure.parentUuid,
					startedAt: file.startedAt,
					...(error === undefined ? {} : { error }),
					...(batch === undefined ? {} : { batch: batch.ref })
				})

				evicted = draft.capFinished()
			}

			return {
				uploadBatches,
				...draft.result(),
				...samples,
				...(evicted.length === 0 ? {} : { rowSpeedSamples: withoutKeys(samples.rowSpeedSamples ?? state.rowSpeedSamples, evicted) })
			}
		})
	},
	clearFinished: () => {
		set(state => {
			const draft = new RowsDraft(state.transfers)
			const cleared = draft.filter(transfer => isActiveTransfer(transfer.status))

			return {
				...draft.result(),
				rowSpeedSamples: withoutKeys(
					state.rowSpeedSamples,
					cleared.map(transfer => transfer.id)
				)
			}
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
// summed size across active rows of known size, times 100) — a consumer feeds it straight into a
// progress bar, never multiplies again. `speedSamples` is optional (defaults to empty -> speed 0) so
// every existing single-argument call site stays valid. Read off the rows' index, never a pass over them.
export function computeTransfersAggregate(
	transfers: readonly Transfer[],
	speedSamples: readonly SpeedSample[] = []
): { activeCount: number; percent: number; speed: number } {
	const index = transfersIndexOf(transfers)

	return {
		activeCount: index.activeCount,
		percent: clampedRatio(index.activeTransferred, index.activeSize, 100),
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
