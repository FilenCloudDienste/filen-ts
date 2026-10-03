import { clampedRatio } from "@filen/shared"
import { driveJobRate, type DriveJob } from "@/features/drive/lib/driveJobs.logic"
import {
	computeTransfersSpeed,
	isActiveTransfer,
	isDriveJobDirection,
	type SpeedSample,
	type Transfer,
	type TransfersStore,
	type UploadBatch
} from "@/features/transfers/store/useTransfersStore"
import { steadyEtaSeconds } from "@/features/transfers/components/transferRow.logic"
import { ROW_HEIGHT, TILE_ROW_HEIGHT } from "@/features/drive/lib/gridLayout"
import type { DriveViewMode } from "@/features/drive/lib/preferences"

// Uploads and drive jobs running into a directory, as the rows its listing shows above its items. A unit
// is one plain upload (a transfer), one directory upload's top-level directory (a run, however many files
// it holds) or one drive job (its single transfers row). Up to MAX_UNIT_ROWS running units get a row each
// and more fold into one summary row; failed uploads the same, below them (a failed job is its card's to
// report). Rows are keyed by string so the listing's membership read compares shallowly and
// changes only when a row comes, goes, fails or a group crosses the threshold, never on a progress tick.
export type PendingRowKey =
	| `upload:${string}`
	| `failedUpload:${string}`
	| `directory:${string}`
	| `failedDirectory:${string}`
	| `job:${string}`
	| "uploading"
	| "failed"

export type PendingRowKind = "upload" | "failedUpload" | "directory" | "failedDirectory" | "job" | "uploading" | "failed"

export function parsePendingRowKey(key: PendingRowKey): { kind: PendingRowKind; id: string } {
	const index = key.indexOf(":")

	if (index === -1) {
		return { kind: key === "uploading" ? "uploading" : "failed", id: "" }
	}

	const kind = key.slice(0, index)

	return {
		kind: kind === "upload" || kind === "failedUpload" || kind === "directory" || kind === "job" ? kind : "failedDirectory",
		id: key.slice(index + 1)
	}
}

const MAX_UNIT_ROWS = 3

export type PendingUploadsState = Pick<TransfersStore, "transfers" | "uploadBatches" | "batchSpeedSamples">

function isPlainUploadInto(transfer: Transfer, parentUuid: string | null): boolean {
	return transfer.batch !== undefined && transfer.batch.directoryName === undefined && transfer.batch.parentUuid === parentUuid
}

// A drive job's row names its destination, null for the root, as an upload run's does.
function isRunningJobInto(transfer: Transfer, parentUuid: string | null): boolean {
	return isDriveJobDirection(transfer.direction) && isActiveTransfer(transfer.status) && transfer.parentUuid === parentUuid
}

function isDirectoryRunInto(batch: UploadBatch, parentUuid: string | null): boolean {
	return batch.ref.directoryName !== undefined && batch.ref.parentUuid === parentUuid
}

// A directory run that ended with failures stays as a failed unit until dismissed.
function isFailedDirectoryRun(batch: UploadBatch): boolean {
	return !batch.running && batch.failed > 0
}

interface UnitCounts {
	running: number
	failed: number
}

function countUnits(state: PendingUploadsState, parentUuid: string | null): UnitCounts {
	let running = 0
	let failed = 0

	for (const id in state.uploadBatches) {
		const batch = state.uploadBatches[id]

		if (batch === undefined || !isDirectoryRunInto(batch, parentUuid)) {
			continue
		}

		if (batch.running) {
			running++
		} else if (isFailedDirectoryRun(batch)) {
			failed++
		}
	}

	for (const transfer of state.transfers) {
		if (isRunningJobInto(transfer, parentUuid)) {
			running++
		} else if (isPlainUploadInto(transfer, parentUuid)) {
			if (transfer.status === "uploading") {
				running++
			} else if (transfer.status === "error") {
				failed++
			}
		}
	}

	return { running, failed }
}

// The block's height for `rows` rows, which the listing reserves above its items: list rows are ROW_HEIGHT
// tall, tiles fill tile rows.
export function pendingBlockHeight(rows: number, viewMode: DriveViewMode, columns: number): number {
	return viewMode === "list" ? rows * ROW_HEIGHT : Math.ceil(rows / columns) * TILE_ROW_HEIGHT
}

function rowsFor(units: number): number {
	return units > MAX_UNIT_ROWS ? 1 : units
}

// What the listing reads: how many rows there are, which sizes the space they take above the items. A
// number, so a progress tick never re-renders the listing. Allocates nothing.
export function pendingRowCount(state: PendingUploadsState, parentUuid: string | null): number {
	const { running, failed } = countUnits(state, parentUuid)

	return rowsFor(running) + rowsFor(failed)
}

// The rows, running units first (directory runs, then plain uploads and drive jobs, each in start order),
// failed after. Two passes over the runs and the transfers, allocating nothing but the result.
export function pendingUploadRowKeys(state: PendingUploadsState, parentUuid: string | null): PendingRowKey[] {
	const { running, failed } = countUnits(state, parentUuid)
	const keys: PendingRowKey[] = []

	if (running > MAX_UNIT_ROWS) {
		keys.push("uploading")
	} else if (running > 0) {
		pushUnitRows(state, parentUuid, keys, "running")
	}

	if (failed > MAX_UNIT_ROWS) {
		keys.push("failed")
	} else if (failed > 0) {
		pushUnitRows(state, parentUuid, keys, "failed")
	}

	return keys
}

function pushUnitRows(state: PendingUploadsState, parentUuid: string | null, keys: PendingRowKey[], kind: "running" | "failed"): void {
	for (const id in state.uploadBatches) {
		const batch = state.uploadBatches[id]

		if (batch === undefined || !isDirectoryRunInto(batch, parentUuid)) {
			continue
		}

		if (kind === "running" && batch.running) {
			keys.push(`directory:${id}`)
		} else if (kind === "failed" && isFailedDirectoryRun(batch)) {
			keys.push(`failedDirectory:${id}`)
		}
	}

	for (const transfer of state.transfers) {
		if (kind === "running" && isRunningJobInto(transfer, parentUuid)) {
			keys.push(`job:${transfer.id}`)

			continue
		}

		if (!isPlainUploadInto(transfer, parentUuid)) {
			continue
		}

		if (kind === "running" && transfer.status === "uploading") {
			keys.push(`upload:${transfer.id}`)
		} else if (kind === "failed" && transfer.status === "error") {
			keys.push(`failedUpload:${transfer.id}`)
		}
	}
}

export interface PendingGroupFigures {
	// Files still uploading.
	files: number
	// Drive jobs still running.
	jobs: number
	// Bytes of the files still counted, net of failed ones, and how many of them moved.
	bytes: number
	transferred: number
}

function addRun(figures: PendingGroupFigures, batch: UploadBatch): void {
	figures.files += batch.files - batch.settledFiles
	figures.bytes += batch.bytes - batch.failedBytes
	figures.transferred += batch.transferred
}

function isRunningInto(batch: UploadBatch | undefined, parentUuid: string | null): batch is UploadBatch {
	return batch?.running === true && batch.ref.parentUuid === parentUuid
}

// The summary row and the scrolled-away bar: every running run and drive job into the directory (the summary
// stands only when all of its running units are folded into it). Read off the runs' own totals, so its
// cost does not grow with the number of files. Speeds are left to the row: they read the clock, which a
// store selector must not.
export function pendingSummaryFigures(state: PendingUploadsState, parentUuid: string | null): PendingGroupFigures {
	const figures: PendingGroupFigures = { files: 0, jobs: 0, bytes: 0, transferred: 0 }

	for (const id in state.uploadBatches) {
		const batch = state.uploadBatches[id]

		if (isRunningInto(batch, parentUuid)) {
			addRun(figures, batch)
		}
	}

	for (const transfer of state.transfers) {
		if (isRunningJobInto(transfer, parentUuid)) {
			figures.jobs += 1
			figures.bytes += transfer.size
			figures.transferred += transfer.bytesTransferred
		}
	}

	return figures
}

// The summary's upload speed windows, one per running run into the directory; each keeps its identity
// until its own run moves. Drive jobs carry their rate on their job instead (pendingJobSpeed).
export function pendingSummarySamples(state: PendingUploadsState, parentUuid: string | null): (readonly SpeedSample[])[] {
	const samples: (readonly SpeedSample[])[] = []

	for (const id in state.uploadBatches) {
		const windowSamples = state.batchSpeedSamples[id]

		if (windowSamples !== undefined && isRunningInto(state.uploadBatches[id], parentUuid)) {
			samples.push(windowSamples)
		}
	}

	return samples
}

// The running drive jobs into the directory, by job id.
export function pendingJobIds(state: PendingUploadsState, parentUuid: string | null): string[] {
	const ids: string[] = []

	for (const transfer of state.transfers) {
		if (isRunningJobInto(transfer, parentUuid)) {
			ids.push(transfer.id)
		}
	}

	return ids
}

// Their combined speed, off each job's own rate, which also counts the files it has not reached yet.
export function pendingJobSpeed(jobs: Readonly<Record<string, DriveJob>>, ids: readonly string[]): number {
	let speed = 0

	for (const id of ids) {
		const job = jobs[id]
		const rate = job === undefined ? null : driveJobRate(job)

		speed += rate?.bytesPerSecond ?? 0
	}

	return speed
}

// One directory run's row.
export function pendingRunFigures(state: PendingUploadsState, batchId: string): PendingGroupFigures {
	const figures: PendingGroupFigures = { files: 0, jobs: 0, bytes: 0, transferred: 0 }
	const batch = state.uploadBatches[batchId]

	if (batch !== undefined) {
		addRun(figures, batch)
	}

	return figures
}

// The combined speed of a group's runs.
export function pendingGroupSpeed(samples: readonly (readonly SpeedSample[])[], now: number = Date.now()): number {
	let speed = 0

	for (const windowSamples of samples) {
		speed += computeTransfersSpeed(windowSamples, now)
	}

	return speed
}

// The failed summary row's count: failed units into the directory.
export function pendingFailedCount(state: PendingUploadsState, parentUuid: string | null): number {
	return countUnits(state, parentUuid).failed
}

export interface PendingGroupProgress {
	percent: number
	etaSeconds: number | null
}

// A group's 0-100 percent and its time left at `speed`, stepped like a transfer row's.
export function pendingGroupProgress(figures: PendingGroupFigures, speed: number): PendingGroupProgress {
	const left = Math.max(0, figures.bytes - figures.transferred)

	return {
		percent: clampedRatio(figures.transferred, figures.bytes, 100),
		etaSeconds: speed > 0 && figures.bytes > 0 ? steadyEtaSeconds(left / speed) : null
	}
}

export interface PendingTargets {
	transferIds: Set<string>
	batchIds: Set<string>
	// Drive jobs, which stop through their own cancel and keep what they made.
	jobIds: Set<string>
}

function emptyTargets(): PendingTargets {
	return { transferIds: new Set(), batchIds: new Set(), jobIds: new Set() }
}

// What a row's Cancel stops: the upload itself, a directory run with its running files, or every running
// upload and drive job into the directory. Runs are marked too, so they start nothing more. A job row's
// own Cancel asks through the job's prompt instead (DriveJobCancelDialog).
export function pendingCancelTargets(state: PendingUploadsState, key: PendingRowKey, parentUuid: string | null): PendingTargets {
	const targets = emptyTargets()
	const { kind, id } = parsePendingRowKey(key)

	if (kind === "upload") {
		targets.transferIds.add(id)

		return targets
	}

	if (kind === "directory") {
		targets.batchIds.add(id)
	} else if (kind === "uploading") {
		for (const batchId in state.uploadBatches) {
			const batch = state.uploadBatches[batchId]

			if (batch?.running === true && batch.ref.parentUuid === parentUuid) {
				targets.batchIds.add(batchId)
			}
		}
	} else {
		return targets
	}

	for (const transfer of state.transfers) {
		if (transfer.status === "uploading" && transfer.batch !== undefined && targets.batchIds.has(transfer.batch.id)) {
			targets.transferIds.add(transfer.id)
		} else if (kind === "uploading" && isRunningJobInto(transfer, parentUuid)) {
			targets.jobIds.add(transfer.id)
		}
	}

	return targets
}

// What a failed row's Dismiss removes: the failed upload, the failed directory run, or every failed unit
// into the directory.
export function pendingDismissTargets(state: PendingUploadsState, key: PendingRowKey, parentUuid: string | null): PendingTargets {
	const targets = emptyTargets()
	const { kind, id } = parsePendingRowKey(key)

	if (kind === "failedUpload") {
		targets.transferIds.add(id)
	} else if (kind === "failedDirectory") {
		targets.batchIds.add(id)
	} else if (kind === "failed") {
		for (const batchId in state.uploadBatches) {
			const batch = state.uploadBatches[batchId]

			if (batch !== undefined && isDirectoryRunInto(batch, parentUuid) && isFailedDirectoryRun(batch)) {
				targets.batchIds.add(batchId)
			}
		}

		for (const transfer of state.transfers) {
			if (transfer.status === "error" && isPlainUploadInto(transfer, parentUuid)) {
				targets.transferIds.add(transfer.id)
			}
		}
	}

	return targets
}

// What the summary's stopped jobs leave: a copy or an extract keeps what it already made, a compress nothing.
export type PendingCancelKept = "copied" | "extracted" | "copiedOrExtracted" | null

export type PendingCancelSubject = { name: string } | { files: number; jobs: number; kept: PendingCancelKept; archives: number }

function runningJobsInto(state: PendingUploadsState, parentUuid: string | null): { kept: PendingCancelKept; archives: number } {
	let copied = false
	let extracted = false
	let archives = 0

	for (const transfer of state.transfers) {
		if (isRunningJobInto(transfer, parentUuid)) {
			copied ||= transfer.direction === "copy"
			extracted ||= transfer.direction === "extract"
			archives += transfer.direction === "compress" ? 1 : 0
		}
	}

	return { kept: copied && extracted ? "copiedOrExtracted" : copied ? "copied" : extracted ? "extracted" : null, archives }
}

// What a row's Cancel confirm names: the upload's or directory's name, or for the summary how many files
// still upload and drive jobs still run, and what those jobs leave. Null once there is nothing left to
// cancel, which closes the confirm.
export function pendingCancelSubject(
	state: PendingUploadsState,
	key: PendingRowKey,
	parentUuid: string | null
): PendingCancelSubject | null {
	const { kind, id } = parsePendingRowKey(key)

	switch (kind) {
		case "upload": {
			const transfer = state.transfers.find(candidate => candidate.id === id)

			return transfer?.status === "uploading" ? { name: transfer.name } : null
		}
		case "directory": {
			const batch = state.uploadBatches[id]

			return batch?.running === true && !batch.cancelled && batch.ref.directoryName !== undefined
				? { name: batch.ref.directoryName }
				: null
		}
		case "uploading": {
			const { files, jobs } = pendingSummaryFigures(state, parentUuid)

			return files > 0 || jobs > 0 ? { files, jobs, ...runningJobsInto(state, parentUuid) } : null
		}
		default:
			return null
	}
}
