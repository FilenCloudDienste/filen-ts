import type { CopyDestination, CopyJobCounts } from "./copyJob"

// What every drive job (copy, compress, extract) shares: its kind, run state, bounded report lists,
// the sources an archive job removes, and the SDK's one archive slot per page.

export type DriveJobKind = "copy" | "compress" | "extract"

export type ArchiveJobKind = Exclude<DriveJobKind, "copy">

export type JobDestination = CopyDestination

export type JobRunStateInput = "running" | "pausing" | "paused" | "cancelling"

export interface JobRunFlags {
	pausing: boolean
	paused: boolean
	cancelling: boolean
}

const RUN_FLAGS: { readonly [K in JobRunStateInput]: Readonly<JobRunFlags> } = {
	running: { pausing: false, paused: false, cancelling: false },
	pausing: { pausing: true, paused: false, cancelling: false },
	paused: { pausing: false, paused: true, cancelling: false },
	cancelling: { pausing: false, paused: false, cancelling: true }
}

// A shared object per state: callers spread it, so nothing is allocated per update.
export function jobRunFlags(runState: JobRunStateInput): Readonly<JobRunFlags> {
	return RUN_FLAGS[runState]
}

// Exact below 2^53 (about 9 PB); past it the figure is only ever shown, so it is held at the edge
// rather than rounded to a value some comparison takes at face value.
export function jobNumber(value: bigint): number {
	const number = Number(value)

	return number > Number.MAX_SAFE_INTEGER
		? Number.MAX_SAFE_INTEGER
		: number < -Number.MAX_SAFE_INTEGER
			? -Number.MAX_SAFE_INTEGER
			: number
}

export function jobNumberOrNull(value: bigint | undefined): number | null {
	return value === undefined ? null : jobNumber(value)
}

// What the earlier calls of a multi-call job did, added to the current call's own counts.
export function addItemCounts(a: CopyJobCounts, b: CopyJobCounts): CopyJobCounts {
	return {
		dirsCreated: a.dirsCreated + b.dirsCreated,
		dirsFailed: a.dirsFailed + b.dirsFailed,
		filesDone: a.filesDone + b.filesDone,
		filesFailed: a.filesFailed + b.filesFailed,
		bytesDone: a.bytesDone + b.bytesDone,
		bytesFailed: a.bytesFailed + b.bytesFailed,
		dirsNotAttempted: a.dirsNotAttempted + b.dirsNotAttempted,
		filesNotAttempted: a.filesNotAttempted + b.filesNotAttempted,
		bytesNotAttempted: a.bytesNotAttempted + b.bytesNotAttempted,
		entriesSkipped: a.entriesSkipped + b.entriesSkipped,
		bytesSkipped: a.bytesSkipped + b.bytesSkipped
	}
}

// The SDK's own report cap: past it a list only counts.
export const REPORT_LIST_CAP = 1000

export interface CappedList<T> {
	readonly items: readonly T[]
	readonly omitted: number
}

export const EMPTY_CAPPED_LIST: CappedList<never> = { items: [], omitted: 0 }

// Returns `list` itself when nothing was added, so a caller can skip its store write. The items array
// is copied only when something fits under the cap.
export function appendCapped<T>(
	list: CappedList<T>,
	additions: readonly T[],
	omittedAdditions: number = 0,
	cap: number = REPORT_LIST_CAP
): CappedList<T> {
	if (additions.length === 0 && omittedAdditions === 0) {
		return list
	}

	const room = cap - list.items.length

	if (room <= 0 || additions.length === 0) {
		return { items: list.items, omitted: list.omitted + additions.length + omittedAdditions }
	}

	const taken = additions.length <= room ? additions : additions.slice(0, room)

	return {
		items: list.items.length === 0 ? taken : list.items.concat(taken),
		omitted: list.omitted + (additions.length - taken.length) + omittedAdditions
	}
}

export function cappedList<T>(items: readonly T[], omitted: number): CappedList<T> {
	if (items.length === 0 && omitted === 0) {
		return EMPTY_CAPPED_LIST
	}

	if (items.length > REPORT_LIST_CAP) {
		return { items: items.slice(0, REPORT_LIST_CAP), omitted: omitted + items.length - REPORT_LIST_CAP }
	}

	return { items, omitted }
}

// A report list as a capped list, converting only what fits under the cap.
export function mapCapped<TIn, TOut>(items: readonly TIn[], omitted: number, convert: (item: TIn) => TOut): CappedList<TOut> {
	const over = Math.max(0, items.length - REPORT_LIST_CAP)

	return cappedList((over === 0 ? items : items.slice(0, REPORT_LIST_CAP)).map(convert), omitted + over)
}

export function cappedTotal(list: CappedList<unknown>): number {
	return list.items.length + list.omitted
}

export interface JobErrorLike {
	kind?: string | undefined
}

export type JobOutcome<TError> =
	| { status: "running" }
	| { status: "done" }
	| { status: "doneWithIssues" }
	| { status: "cancelled" }
	// neededBytes is null when the refusal came part way through, which states no total.
	| { status: "quotaExceeded"; neededBytes: number | null; freeBytes: number }
	| { status: "passwordRequired" }
	| { status: "wrongPassword" }
	| { status: "failed"; error: TError }

export function isJobRunning(job: { outcome: { status: string } }): boolean {
	return job.outcome.status === "running"
}

// Speed and time left only mean something while bytes are moving.
export function jobRate(job: {
	outcome: { status: string }
	paused: boolean
	pausing: boolean
	bytesPerSecond: number | null
	etaMs: number | null
}): { bytesPerSecond: number; etaSeconds: number | null } | null {
	if (!isJobRunning(job) || job.paused || job.pausing || job.bytesPerSecond === null || job.bytesPerSecond <= 0) {
		return null
	}

	return { bytesPerSecond: job.bytesPerSecond, etaSeconds: job.etaMs === null ? null : Math.ceil(job.etaMs / 1000) }
}

export type SourceDisposalKind = "trash" | "deletePermanently"

type KeptReasonOf<TBytes, TError> =
	| { type: "incomplete" }
	| { type: "unaccountedData"; bytes: TBytes }
	| { type: "hashMismatch" }
	| { type: "hashUnavailable" }
	| { type: "changed" }
	| { type: "unconfirmed" }
	| { type: "hasVersions" }
	| { type: "interrupted" }
	| { type: "failed"; error: TError }

export type KeptReasonInput<TError> = KeptReasonOf<bigint, TError>

export type KeptReason<TError> = KeptReasonOf<number, TError>

type DisposalOutcomeOf<TBytes, TError> =
	| { type: "disposed"; how: SourceDisposalKind; bytesFreed: TBytes }
	| { type: "kept"; reason: KeptReasonOf<TBytes, TError>; bytesFreed: TBytes }

export type DisposalOutcomeInput<TError> = DisposalOutcomeOf<bigint, TError>

export type JobDisposalOutcome<TError> = DisposalOutcomeOf<number, TError>

// What became of one source a job was to remove (an extract's archive, a compress's items).
export interface DispositionInput<TError> {
	uuid: string
	outcome: DisposalOutcomeInput<TError>
}

export interface JobDisposition<TError> {
	uuid: string
	outcome: JobDisposalOutcome<TError>
}

export function toDisposition<TError>(input: DispositionInput<TError>): JobDisposition<TError> {
	const { outcome } = input

	if (outcome.type === "disposed") {
		return { uuid: input.uuid, outcome: { type: "disposed", how: outcome.how, bytesFreed: jobNumber(outcome.bytesFreed) } }
	}

	const { reason } = outcome

	return {
		uuid: input.uuid,
		outcome: {
			type: "kept",
			reason: reason.type === "unaccountedData" ? { type: "unaccountedData", bytes: jobNumber(reason.bytes) } : reason,
			bytesFreed: jobNumber(outcome.bytesFreed)
		}
	}
}

export interface DispositionSummary {
	disposed: number
	kept: number
	// A kept source can still have freed some (a directory whose removal stopped part way).
	bytesFreed: number
	trashed: string[]
	deleted: string[]
}

export function summarizeDispositions<TError>(list: readonly JobDisposition<TError>[]): DispositionSummary {
	const summary: DispositionSummary = { disposed: 0, kept: 0, bytesFreed: 0, trashed: [], deleted: [] }

	for (const { uuid, outcome } of list) {
		summary.bytesFreed += outcome.bytesFreed

		if (outcome.type === "kept") {
			summary.kept++

			continue
		}

		summary.disposed++

		if (outcome.how === "trash") {
			summary.trashed.push(uuid)
		} else {
			summary.deleted.push(uuid)
		}
	}

	return summary
}

// The SDK runs one archive job (compress, extract or listing) per page, later ones waiting for it; a
// paused job keeps the slot.
export interface ArchiveSlotJob {
	id: string
	kind: DriveJobKind
	phase: string
	paused: boolean
	outcome: { status: string }
}

export function isWaitingForArchiveSlot(job: ArchiveSlotJob): boolean {
	return job.kind !== "copy" && isJobRunning(job) && job.phase === "waitingForWorker"
}

// A compress lists its sources before it asks for the slot.
export function holdsArchiveSlot(job: ArchiveSlotJob): boolean {
	return (
		job.kind !== "copy" &&
		isJobRunning(job) &&
		job.phase !== "waitingForWorker" &&
		!(job.kind === "compress" && job.phase === "scanning")
	)
}

export function pausedJobBlocksSlot(jobs: Iterable<ArchiveSlotJob>, id: string): boolean {
	let blocking = false
	let waiting = false

	for (const job of jobs) {
		if (job.id === id) {
			if (!job.paused || !holdsArchiveSlot(job)) {
				return false
			}

			blocking = true
		} else if (!waiting && isWaitingForArchiveSlot(job)) {
			waiting = true
		}

		if (blocking && waiting) {
			return true
		}
	}

	return false
}
